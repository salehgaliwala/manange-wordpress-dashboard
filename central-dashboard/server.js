const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const SafeUpdateOrchestrator = require('./orchestrator');

const app = express();
app.use(express.json());

// Serve static React dashboard files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Set default port to 3002 as requested
const PORT = process.env.PORT || 3002;

// Setup directories
const VAULT_DIR = path.join(__dirname, 'vault');
if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
}

// Multer storage for uploaded plugin packages
const upload = multer({ dest: path.join(__dirname, 'temp_uploads') });

// In-memory Database stores
const ADMIN_CREDENTIALS = {
    username: process.env.DASHBOARD_ADMIN_USER || 'admin',
    passwordHash: crypto.createHash('sha256').update(process.env.DASHBOARD_ADMIN_PASS || 'SecurePassword123').digest('hex')
};

const TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
const ACTIVE_TOKENS = new Set();

const SITES_DB = {
    'example-wp-site': {
        url: 'http://localhost:8080',
        secretKey: 'wp_central_shared_secret_key_999',
        dashboardBaseUrl: 'http://localhost:3002',
        s3Config: {
            bucket: 'wp-backups-bucket',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            region: 'us-east-1',
            accessKey: 'MOCK_S3_ACCESS_KEY',
            secretKey: 'MOCK_S3_SECRET_KEY'
        }
    }
};

const VAULT_DB = {};

/**
 * Authentication Middleware
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access Denied. No authorization header or Bearer token provided.' });
    }

    const token = authHeader.split(' ')[1];
    if (!ACTIVE_TOKENS.has(token)) {
        return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }

    next();
}

/**
 * Endpoint GET /
 * Serves the beautiful, interactive React/Tailwind landing UI dashboard
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Endpoint to login and receive a session token
 * POST /api/login
 */
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    const inputHash = crypto.createHash('sha256').update(password).digest('hex');

    if (username === ADMIN_CREDENTIALS.username && inputHash === ADMIN_CREDENTIALS.passwordHash) {
        const tokenPayload = `${username}:${Date.now()}`;
        const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(tokenPayload).digest('hex');
        const token = Buffer.from(`${tokenPayload}.${signature}`).toString('base64');

        ACTIVE_TOKENS.add(token);

        return res.status(200).json({
            message: 'Authentication successful.',
            token: token
        });
    }

    return res.status(401).json({ error: 'Invalid username or password.' });
});

/**
 * Upload & Parse Premium/Custom Plugin Vault API
 * POST /api/plugins/upload
 * Protected by requireAuth
 */
app.post('/api/plugins/upload', requireAuth, upload.single('plugin'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No plugin zip file uploaded.' });
    }

    const tempFilePath = req.file.path;

    try {
        const zip = new AdmZip(tempFilePath);
        const zipEntries = zip.getEntries();

        let mainPhpFileEntry = null;
        let mainPhpContent = '';
        let detectedSlug = '';

        // Scan all .php files to find the entry with the "Plugin Name:" header
        for (const entry of zipEntries) {
            if (!entry.isDirectory && entry.entryName.endsWith('.php')) {
                const content = entry.getData().toString('utf8');
                if (content.includes('Plugin Name:')) {
                    mainPhpFileEntry = entry;
                    mainPhpContent = content;

                    // Extract slug from the first directory part of the entry path, e.g. "my-plugin/my-plugin.php" -> "my-plugin"
                    const parts = entry.entryName.split('/');
                    detectedSlug = parts[0] || path.basename(entry.entryName, '.php');
                    break;
                }
            }
        }

        if (!mainPhpFileEntry) {
            fs.unlinkSync(tempFilePath);
            return res.status(400).json({ error: 'Invalid WordPress plugin zip: main PHP file with "Plugin Name" header not found.' });
        }

        // Parse header metadata using Regex
        const nameMatch = mainPhpContent.match(/Plugin Name:\s*(.*)/i);
        const versionMatch = mainPhpContent.match(/Version:\s*(.*)/i);
        const authorMatch = mainPhpContent.match(/Author:\s*(.*)/i);

        const pluginName = nameMatch ? nameMatch[1].trim() : 'Unknown Plugin';
        const version = versionMatch ? versionMatch[1].trim() : '1.0.0';
        const author = authorMatch ? authorMatch[1].trim() : 'Unknown Author';

        if (!detectedSlug) {
            detectedSlug = pluginName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        }

        // Securely store the zip using the slug as file name
        const finalZipPath = path.join(VAULT_DIR, `${detectedSlug}.zip`);
        fs.renameSync(tempFilePath, finalZipPath);

        // Record parsed metadata in Database store
        const metadata = {
            name: pluginName,
            slug: detectedSlug,
            version: version,
            author: author,
            filePath: finalZipPath,
            uploadedAt: new Date().toISOString()
        };

        VAULT_DB[detectedSlug] = metadata;

        console.log(`[Plugin Vault] Successfully uploaded and parsed plugin: ${pluginName} (${detectedSlug}) v${version}`);

        return res.status(200).json({
            message: 'Plugin successfully uploaded, parsed, and vaulted.',
            plugin: metadata
        });

    } catch (err) {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        console.error('[Plugin Vault Error]', err);
        return res.status(500).json({ error: 'Failed to process and parse uploaded plugin zip.', details: err.message });
    }
});

/**
 * Secure Sideload Plugin Download URL (Validates short-lived HMAC token)
 * GET /api/plugins/download/:slug
 * Publicly reachable but requires valid cryptographic download token to prevent unauthorized access
 */
app.get('/api/plugins/download/:slug', (req, res) => {
    const { slug } = req.params;
    const { token } = req.query;

    if (!token) {
        return res.status(401).json({ error: 'Access denied. Missing pre-signed download token.' });
    }

    // Look up local plugin metadata
    const metadata = VAULT_DB[slug];
    const zipPath = path.join(VAULT_DIR, `${slug}.zip`);

    if (!metadata || !fs.existsSync(zipPath)) {
        return res.status(404).json({ error: 'Requested plugin package not found in vault.' });
    }

    try {
        // Decode and verify the HMAC download token
        const decodedToken = Buffer.from(token, 'base64').toString('ascii');
        const [expires, signature] = decodedToken.split(':');

        if (!expires || !signature) {
            return res.status(403).json({ error: 'Invalid pre-signed token format.' });
        }

        // Validate expiration
        if (Math.floor(Date.now() / 1000) > parseInt(expires)) {
            return res.status(403).json({ error: 'Pre-signed download link has expired.' });
        }

        // Validate HMAC Signature using shared secret
        const siteKey = SITES_DB['example-wp-site'].secretKey;
        const dataToSign = `${slug}:${expires}`;
        const expectedSignature = crypto
            .createHmac('sha256', siteKey)
            .update(dataToSign)
            .digest('hex');

        // Safe timing comparison by first checking identical length
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedSignature);

        if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
            return res.status(403).json({ error: 'Pre-signed token verification failed.' });
        }

        // Stream/Send the zip file directly
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${slug}.zip`);
        return res.sendFile(zipPath);

    } catch (err) {
        console.error('[Download Stream Error]', err);
        return res.status(500).json({ error: 'Error processing download request.' });
    }
});

/**
 * Protected Endpoint to trigger a safe update pipeline for a registered WordPress site
 * POST /api/sites/:siteId/safe-update
 * Protected by requireAuth
 */
app.post('/api/sites/:siteId/safe-update', requireAuth, async (req, res) => {
    const { siteId } = req.params;
    const { type, plugins } = req.body;

    const site = SITES_DB[siteId];
    if (!site) {
        return res.status(404).json({ error: 'Site not registered on dashboard.' });
    }

    if (!type || (type === 'plugin' && (!plugins || !Array.isArray(plugins)))) {
        return res.status(400).json({ error: 'Invalid parameters. Need "type" and "plugins" if updating plugins.' });
    }

    const orchestrator = new SafeUpdateOrchestrator(site);

    try {
        const result = await orchestrator.executeSafeUpdate({ type, plugins });
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json({
            error: 'Safe update pipeline failed to execute fully.',
            message: err.message
        });
    }
});

/**
 * Health check endpoint (unprotected)
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'WP Central Dashboard' });
});

// Provide a way for testing script to retrieve VAULT_DB
app.get('/api/test/vault', (req, res) => {
    res.json(VAULT_DB);
});

app.listen(PORT, () => {
    console.log(`Central Dashboard Backend listening at http://localhost:${PORT}`);
});
