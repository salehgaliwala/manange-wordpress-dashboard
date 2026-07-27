const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const SafeUpdateOrchestrator = require('./orchestrator');

const app = express();
app.use(express.json());

// Log all incoming requests for easy debugging and diagnostic visibility
app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

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

// File-based JSON Database persistence helpers
const DB_PATH = path.join(__dirname, 'data.json');

// Global tracking dictionary for asynchronous update pipeline jobs persisted in DB
function getActiveJobs() {
    const db = loadDB();
    return db.jobs || {};
}

function saveActiveJob(jobId, jobState) {
    const db = loadDB();
    db.jobs = db.jobs || {};
    db.jobs[jobId] = jobState;
    saveDB(db);
}

function loadDB() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const content = fs.readFileSync(DB_PATH, 'utf8');
            if (content && content.trim()) {
                return JSON.parse(content);
            }
        }
    } catch (err) {
        console.error('[DB Error] Failed to load JSON database:', err);
    }

    // Only generate fallback and write to disk if the file DOES NOT exist at all
    if (!fs.existsSync(DB_PATH)) {
        const fallback = {
            admin: {
                username: process.env.DASHBOARD_ADMIN_USER || 'admin@example.com',
                passwordHash: crypto.createHash('sha256').update(process.env.DASHBOARD_ADMIN_PASS || 'SecurePassword123').digest('hex')
            },
            tokenSecret: crypto.randomBytes(32).toString('hex'),
            sites: [
                {
                    id: 'example-wp-site',
                    name: 'Local WP Container',
                    url: 'http://localhost:8080',
                    secretKey: 'wp_central_shared_secret_key_999',
                    dashboardBaseUrl: 'http://localhost:3002',
                    wpVersion: '6.4.2',
                    pendingUpdates: 2,
                    lastBackupStatus: 'success',
                    lastBackupTime: '2 hrs ago',
                    s3Config: {
                        bucket: 'wp-backups-bucket',
                        endpoint: 'https://s3.us-east-1.amazonaws.com',
                        region: 'us-east-1',
                        accessKey: 'MOCK_S3_ACCESS_KEY',
                        secretKey: 'MOCK_S3_SECRET_KEY'
                    }
                }
            ],
            vault: {}
        };
        try {
            fs.writeFileSync(DB_PATH, JSON.stringify(fallback, null, 2), 'utf8');
        } catch (e) {}
        return fallback;
    }

    // Fallback parser safety check if exists but parsing failed temporarily
    try {
        const content = fs.readFileSync(DB_PATH, 'utf8');
        if (content) return JSON.parse(content);
    } catch (e) {}
}

function saveDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('[DB Error] Failed to save JSON database:', err);
    }
}

/**
 * Verify Session Token (Stateless but persistent & cryptographically signed)
 * Tokens contain the login username and absolute expiration timestamp (30 days from generation)
 * Decodes, checks expiration, and validates HMAC against DB-persisted tokenSecret.
 */
function verifyToken(token) {
    if (!token) return null;
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const lastDotIndex = decoded.lastIndexOf('.');
        if (lastDotIndex === -1) return null;

        const payload = decoded.substring(0, lastDotIndex);
        const signature = decoded.substring(lastDotIndex + 1);

        const db = loadDB();
        const expectedSignature = crypto.createHmac('sha256', db.tokenSecret).update(payload).digest('hex');

        // Timing-safe signature check
        const sigBuf = Buffer.from(signature, 'hex');
        const expectedBuf = Buffer.from(expectedSignature, 'hex');
        if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
            return null;
        }

        const [username, expiresAtStr] = payload.split(':');
        const expiresAt = parseInt(expiresAtStr, 10);
        if (isNaN(expiresAt) || Date.now() > expiresAt) {
            return null; // Expired session
        }

        return { username };
    } catch (err) {
        return null;
    }
}

/**
 * Authentication Middleware
 * Supports validating both Bearer authorization headers and HTTP cookie sessions.
 */
function requireAuth(req, res, next) {
    let token = null;

    // 1. Extract from Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    }

    // 2. Extract from cookies if header was not provided
    if (!token && req.headers.cookie) {
        const cookies = {};
        req.headers.cookie.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            if (parts.length >= 2) {
                cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('='));
            }
        });
        token = cookies['wp_central_session'];
    }

    const session = verifyToken(token);
    if (!session) {
        return res.status(401).json({ error: 'Access Denied. Please sign in with admin credentials.' });
    }

    req.user = session;
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
 * Endpoint to check login session state
 * GET /api/session
 */
app.get('/api/session', (req, res) => {
    let token = null;

    // Extract from Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    }

    // Extract from cookies
    if (!token && req.headers.cookie) {
        const cookies = {};
        req.headers.cookie.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            if (parts.length >= 2) {
                cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('='));
            }
        });
        token = cookies['wp_central_session'];
    }

    const session = verifyToken(token);
    if (!session) {
        return res.status(401).json({ authenticated: false });
    }

    return res.json({ authenticated: true, username: session.username });
});

/**
 * Endpoint to login and receive a session token
 * POST /api/login
 * Sets a 30-day cookie wp_central_session
 */
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    const db = loadDB();
    const adminUsername = db.admin.username;
    const adminPasswordHash = db.admin.passwordHash;

    console.log('[DEBUG LOGIN] Received username:', username, 'password:', password);
    console.log('[DEBUG LOGIN] Expected username:', adminUsername, 'expected hash:', adminPasswordHash);

    // Accept administrative login (any matching admin email format or username prefix)
    const isMatchingUsername = username === adminUsername || username.split('@')[0] === adminUsername.split('@')[0];
    const inputHash = crypto.createHash('sha256').update(password).digest('hex');

    console.log('[DEBUG LOGIN] user match:', isMatchingUsername, 'pass match:', inputHash === adminPasswordHash);

    if (isMatchingUsername && inputHash === adminPasswordHash) {
        // Generate stateless signed token with 30-day expiration
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        const tokenPayload = `${username}:${expiresAt}`;
        const signature = crypto.createHmac('sha256', db.tokenSecret).update(tokenPayload).digest('hex');
        const token = Buffer.from(`${tokenPayload}.${signature}`).toString('base64');

        // Set secure session cookie valid for 30 days (2592000 seconds)
        res.setHeader('Set-Cookie', `wp_central_session=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`);

        return res.status(200).json({
            message: 'Authentication successful.',
            token: token
        });
    }

    return res.status(401).json({ error: 'Invalid username or password.' });
});

/**
 * Endpoint to change password safely
 * POST /api/change-password
 * Protected by requireAuth
 */
app.post('/api/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current password and new password are required.' });
    }

    const db = loadDB();
    const currentHash = crypto.createHash('sha256').update(currentPassword).digest('hex');

    if (currentHash !== db.admin.passwordHash) {
        return res.status(400).json({ error: 'Incorrect current password.' });
    }

    db.admin.passwordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    saveDB(db);

    res.json({ message: 'Password successfully changed.' });
});

/**
 * CRUD Connected Site Routes (Protected)
 */
app.get('/api/sites', requireAuth, (req, res) => {
    const db = loadDB();
    res.json(db.sites || []);
});

app.post('/api/sites', requireAuth, (req, res) => {
    const { name, url, secretKey } = req.body;
    if (!name || !url) {
        return res.status(400).json({ error: 'Site name and URL are required.' });
    }

    const db = loadDB();
    const newId = crypto.randomUUID ? crypto.randomUUID() : `site_${Date.now()}`;
    const newSite = {
        id: newId,
        name,
        url,
        secretKey: secretKey || 'wp_central_shared_secret_key_999',
        dashboardBaseUrl: `http://localhost:${PORT}`,
        wpVersion: '6.4.2',
        pendingUpdates: 0,
        lastBackupStatus: 'success',
        lastBackupTime: 'Never',
        s3Config: {
            bucket: 'wp-backups-bucket',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            region: 'us-east-1',
            accessKey: 'MOCK_S3_ACCESS_KEY',
            secretKey: 'MOCK_S3_SECRET_KEY'
        }
    };

    db.sites = db.sites || [];
    db.sites.push(newSite);
    saveDB(db);

    res.status(201).json(newSite);
});

app.delete('/api/sites/:siteId', requireAuth, (req, res) => {
    const { siteId } = req.params;
    const db = loadDB();
    const initialLength = db.sites.length;
    db.sites = db.sites.filter(s => s.id !== siteId);
    if (db.sites.length === initialLength) {
        return res.status(404).json({ error: 'Site not found.' });
    }
    saveDB(db);
    res.json({ message: 'Site successfully deleted.' });
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
        } else {
            // Aggressively sanitize slug to prevent path traversal or other malicious file injection
            detectedSlug = detectedSlug.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
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

        const db = loadDB();
        db.vault = db.vault || {};
        db.vault[detectedSlug] = metadata;
        saveDB(db);

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
    const db = loadDB();
    const metadata = db.vault ? db.vault[slug] : null;
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
        const siteKey = db.sites && db.sites.length > 0 ? db.sites[0].secretKey : 'wp_central_shared_secret_key_999';
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
 * Protected Endpoint to trigger a manual synchronization of a site's WP version and pending updates
 * POST /api/sites/:siteId/sync
 * Protected by requireAuth
 */
app.post('/api/sites/:siteId/sync', requireAuth, async (req, res) => {
    const { siteId } = req.params;

    const db = loadDB();
    const siteIndex = db.sites ? db.sites.findIndex(s => s.id === siteId) : -1;
    if (siteIndex === -1) {
        return res.status(404).json({ error: 'Site not registered on dashboard.' });
    }

    const site = db.sites[siteIndex];
    const orchestrator = new SafeUpdateOrchestrator(site);

    try {
        // Query the remote worker /status endpoint
        const response = await orchestrator.signedGet('/wp-json/wp-central/v1/status');
        const data = response.data;

        // Persist real values in our database
        db.sites[siteIndex].wpVersion = data.wp_version || '6.4.2';
        db.sites[siteIndex].pendingUpdates = data.total_updates !== undefined ? data.total_updates : 0;
        saveDB(db);

        return res.json({
            message: 'Site status synced successfully.',
            site: db.sites[siteIndex]
        });
    } catch (err) {
        console.error('[Sync Error]', err.message);
        return res.status(500).json({
            error: 'Failed to query and sync target site status.',
            message: err.message
        });
    }
});

/**
 * Get active job for a site
 * GET /api/sites/:siteId/active-job
 */
app.get('/api/sites/:siteId/active-job', requireAuth, (req, res) => {
    const { siteId } = req.params;
    const db = loadDB();
    const jobs = db.jobs || {};
    const activeJob = Object.values(jobs).find(j => j.siteId === siteId && j.status === 'processing');
    if (activeJob) {
        return res.json(activeJob);
    }
    return res.status(404).json({ error: 'No active job found for this site.' });
});

/**
 * GET /api/jobs/active
 * Returns any active, paused, or stopped jobs currently in the registry
 */
app.get('/api/jobs/active', requireAuth, (req, res) => {
    const db = loadDB();
    const jobs = db.jobs || {};
    return res.json(Object.values(jobs));
});

/**
 * Pause job
 * POST /api/jobs/:jobId/pause
 * Protected by requireAuth
 */
app.post('/api/jobs/:jobId/pause', requireAuth, async (req, res) => {
    const { jobId } = req.params;
    const db = loadDB();
    const job = db.jobs ? db.jobs[jobId] : null;
    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }
    if (job.status !== 'processing') {
        return res.status(400).json({ error: 'Only actively processing jobs can be paused.' });
    }

    job.status = 'paused';
    job.step = 'paused';
    job.stepDescription = 'Job paused by administrator.';
    saveDB(db);

    // Send signal to target WP worker
    const siteId = job.siteId;
    const site = db.sites ? db.sites.find(s => s.id === siteId) : null;
    if (site) {
        const orchestrator = new SafeUpdateOrchestrator(site);
        try {
            await orchestrator.signedPost('/wp-json/wp-central/v1/job-control', {
                job_id: jobId,
                action: 'pause'
            });
        } catch (err) {
            console.warn('[Dashboard Pause] Failed to notify target worker of pause:', err.message);
        }
    }

    return res.json({ message: 'Pause signal registered successfully.', job });
});

/**
 * Kill job
 * POST /api/jobs/:jobId/kill
 * Protected by requireAuth
 */
app.post('/api/jobs/:jobId/kill', requireAuth, async (req, res) => {
    const { jobId } = req.params;
    const db = loadDB();
    const job = db.jobs ? db.jobs[jobId] : null;
    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    job.status = 'killed';
    job.step = 'killed';
    job.stepDescription = 'Pipeline forcibly aborted.';
    saveDB(db);

    // Send signal to target WP worker
    const siteId = job.siteId;
    const site = db.sites ? db.sites.find(s => s.id === siteId) : null;
    if (site) {
        const orchestrator = new SafeUpdateOrchestrator(site);
        try {
            await orchestrator.signedPost('/wp-json/wp-central/v1/job-control', {
                job_id: jobId,
                action: 'kill'
            });
        } catch (err) {
            console.warn('[Dashboard Kill] Failed to notify target worker of cancellation:', err.message);
        }
    }

    // Clean up active temp files associated with jobId (screenshots, etc)
    try {
        const publicFiles = fs.readdirSync(path.join(__dirname, 'public'));
        for (const file of publicFiles) {
            if (file.includes(jobId)) {
                fs.unlinkSync(path.join(__dirname, 'public', file));
            }
        }
    } catch (e) {}

    return res.json({ message: 'Kill signal dispatched successfully.', job });
});

/**
 * Delete job record
 * DELETE /api/jobs/:jobId
 * Protected by requireAuth
 */
app.delete('/api/jobs/:jobId', requireAuth, (req, res) => {
    const { jobId } = req.params;
    const db = loadDB();
    const job = db.jobs ? db.jobs[jobId] : null;
    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status === 'processing') {
        return res.status(400).json({ error: 'Cannot delete an actively processing job. Kill or pause it first.' });
    }

    delete db.jobs[jobId];
    saveDB(db);

    // Remove any visual regression screenshot files or local archives created for this job ID
    try {
        const publicFiles = fs.readdirSync(path.join(__dirname, 'public'));
        for (const file of publicFiles) {
            if (file.includes(jobId)) {
                fs.unlinkSync(path.join(__dirname, 'public', file));
            }
        }
    } catch (e) {}

    return res.json({ message: 'Job record successfully removed.' });
});

/**
 * Real-time Active Updates status query endpoint
 * GET /api/jobs/:jobId
 * Protected by requireAuth
 */
app.get('/api/jobs/:jobId', requireAuth, (req, res) => {
    const { jobId } = req.params;
    const db = loadDB();
    const job = db.jobs ? db.jobs[jobId] : null;
    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }
    return res.json(job);
});

/**
 * Request step resumption for a suspended/broken job
 * POST /api/jobs/:jobId/resume
 * Protected by requireAuth
 */
app.post('/api/jobs/:jobId/resume', requireAuth, async (req, res) => {
    const { jobId } = req.params;
    const db = loadDB();
    const job = db.jobs ? db.jobs[jobId] : null;
    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status !== 'broken' && !job.resumable) {
        return res.status(400).json({ error: 'Job is not in a resumable/broken state.' });
    }

    const siteId = job.siteId;
    const site = db.sites ? db.sites.find(s => s.id === siteId) : null;
    if (!site) {
        return res.status(404).json({ error: 'Associated site not found.' });
    }

    // Set status back to processing
    job.status = 'processing';
    job.progress = job.progress || 10;
    job.error = null;
    job.step = 'Resuming pipeline execution...';
    saveActiveJob(jobId, job);

    const orchestrator = new SafeUpdateOrchestrator(site);
    const updateParams = { ...job.updateParams, jobId };

    // Launch pipeline in background
    orchestrator.executeSafeUpdate(
        updateParams,
        (progress, step) => {
            const currentDB = loadDB();
            if (currentDB.jobs && currentDB.jobs[jobId]) {
                currentDB.jobs[jobId].progress = progress;
                currentDB.jobs[jobId].step = step;
                saveDB(currentDB);
            }
        }
    ).then(result => {
        const currentDB = loadDB();
        if (currentDB.jobs && currentDB.jobs[jobId]) {
            currentDB.jobs[jobId].status = 'completed';
            currentDB.jobs[jobId].progress = 100;
            currentDB.jobs[jobId].step = '✓ Pipeline execution complete! Target updated safely.';
            currentDB.jobs[jobId].completed = true;
            currentDB.jobs[jobId].backup_path = result.backup_path || 'S3 Cloud Storage Bucket';

            const sIdx = currentDB.sites.findIndex(s => s.id === siteId);
            if (sIdx !== -1) {
                currentDB.sites[sIdx].pendingUpdates = 0;
                currentDB.sites[sIdx].lastBackupStatus = 'success';
                currentDB.sites[sIdx].lastBackupTime = 'Just now';
            }
            saveDB(currentDB);
        }
    }).catch(err => {
        const currentDB = loadDB();
        if (currentDB.jobs && currentDB.jobs[jobId]) {
            if (currentDB.jobs[jobId].status !== 'broken') {
                currentDB.jobs[jobId].status = 'broken';
            }
            currentDB.jobs[jobId].completed = false;
            currentDB.jobs[jobId].resumable = true;
            currentDB.jobs[jobId].step = `⚠️ Pipeline failed: ${err.message}`;
            currentDB.jobs[jobId].error = err.message;

            const sIdx = currentDB.sites.findIndex(s => s.id === siteId);
            if (sIdx !== -1) {
                currentDB.sites[sIdx].lastBackupStatus = 'fail';
                currentDB.sites[sIdx].lastBackupTime = 'Just now (Error)';
            }
            saveDB(currentDB);
        }
    });

    return res.json({
        message: 'Job resumption initiated successfully.',
        job
    });
});

/**
 * Fetch detailed pending updates list dynamically from the target WordPress worker
 * GET /api/sites/:siteId/updates-list
 * Protected by requireAuth
 */
// Fetch detailed pending updates list dynamically from the target WordPress worker
app.get('/api/sites/:siteId/updates-list', requireAuth, async (req, res) => {
    const { siteId } = req.params;
    const db = loadDB();
    const site = db.sites ? db.sites.find(s => s.id === siteId) : null;
    
    if (!site) {
        return res.status(404).json({ error: 'Site not registered.' });
    }

    const orchestrator = new SafeUpdateOrchestrator(site);
    try {
        const response = await orchestrator.signedGet('/wp-json/wp-central/v1/status');
        const data = response.data;

        // Extract real plugin array returned by the updated worker plugin
        const pendingPlugins = data.plugins_detail || [];

        return res.json({
            wp_version: data.wp_version || site.wpVersion || '6.4.2',
            pending_core: data.pending_core > 0,
            pending_plugins: pendingPlugins
        });
    } catch (err) {
        console.error('[Fetch Updates List Error]', err.message);
        if (err.response) {
            console.error('Server responded with:', err.response.status, err.response.data);
        }
        return res.status(500).json({
            error: 'Failed to fetch updates list from target site.',
            message: err.message
        });
    }
});

/**
 * Protected Endpoint to trigger a safe update pipeline for a registered WordPress site
 * POST /api/sites/:siteId/safe-update
 * Protected by requireAuth
 * Returns a 202 Accepted immediately with a unique Job ID so the frontend can poll progress dynamically!
 */
app.post('/api/sites/:siteId/safe-update', requireAuth, async (req, res) => {
    const { siteId } = req.params;
    const { type, plugins, backup_destination } = req.body;

    const db = loadDB();
    const site = db.sites ? db.sites.find(s => s.id === siteId) : null;
    if (!site) {
        return res.status(404).json({ error: 'Site not registered on dashboard.' });
    }

    if (!type || (type === 'plugin' && (!plugins || !Array.isArray(plugins)))) {
        return res.status(400).json({ error: 'Invalid parameters. Need "type" and "plugins" if updating plugins.' });
    }

    // Generate unique Job ID on the dashboard
    const jobId = 'job_dashboard_' + Date.now();
    const destination = backup_destination || 's3';

    // Initialize job state in tracking map
    const initialJobState = {
        id: jobId,
        siteId: siteId,
        status: 'processing',
        progress: 10,
        step: 'Initializing Pipeline Connection...',
        error: null,
        completed: false,
        backup_path: '',
        updateParams: { type, plugins, backup_destination: destination }
    };
    saveActiveJob(jobId, initialJobState);

    const orchestrator = new SafeUpdateOrchestrator(site);

    // We execute the promise in the background without holding the HTTP response thread
    orchestrator.executeSafeUpdate(
        { jobId, type, plugins, backup_destination: destination },
        (progress, step) => {
            // Progress Callback: Update active jobs tracking map in real-time
            const currentDB = loadDB();
            if (currentDB.jobs && currentDB.jobs[jobId]) {
                currentDB.jobs[jobId].progress = progress;
                currentDB.jobs[jobId].step = step;
                saveDB(currentDB);
            }
        }
    ).then(result => {
        // On Success
        const currentDB = loadDB();
        if (currentDB.jobs && currentDB.jobs[jobId]) {
            currentDB.jobs[jobId].status = 'completed';
            currentDB.jobs[jobId].progress = 100;
            currentDB.jobs[jobId].step = '✓ Pipeline execution complete! Target updated safely.';
            currentDB.jobs[jobId].completed = true;
            currentDB.jobs[jobId].backup_path = result.backup_path || 'S3 Cloud Storage Bucket';

            // Update database metrics dynamically
            const sIdx = currentDB.sites.findIndex(s => s.id === siteId);
            if (sIdx !== -1) {
                currentDB.sites[sIdx].pendingUpdates = 0;
                currentDB.sites[sIdx].lastBackupStatus = 'success';
                currentDB.sites[sIdx].lastBackupTime = 'Just now';
            }
            saveDB(currentDB);
        }
    }).catch(err => {
        // On Failure
        const currentDB = loadDB();
        if (currentDB.jobs && currentDB.jobs[jobId]) {
            if (currentDB.jobs[jobId].status !== 'broken') {
                currentDB.jobs[jobId].status = 'broken';
            }
            currentDB.jobs[jobId].completed = false;
            currentDB.jobs[jobId].resumable = true;
            currentDB.jobs[jobId].step = `⚠️ Pipeline failed: ${err.message}`;
            currentDB.jobs[jobId].error = err.message;

            // Update database metrics dynamically
            const sIdx = currentDB.sites.findIndex(s => s.id === siteId);
            if (sIdx !== -1) {
                currentDB.sites[sIdx].lastBackupStatus = 'fail';
                currentDB.sites[sIdx].lastBackupTime = 'Just now (Error)';
            }
            saveDB(currentDB);
        }
    });

    // Return 202 Accepted immediately with the dashboard Job ID!
    return res.status(202).json({
        status: 'accepted',
        job_id: jobId
    });
});

/**
 * Health check endpoint (unprotected)
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'WP Central Dashboard' });
});

/**
 * GET /api/vault
 * Returns the list of vaulted plugins
 * Protected by requireAuth
 */
app.get('/api/vault', requireAuth, (req, res) => {
    const db = loadDB();
    const vault = db.vault || {};
    return res.json(Object.values(vault));
});

/**
 * DELETE /api/vault/:slug
 * Deletes a plugin from the vault and disk
 * Protected by requireAuth
 */
app.delete('/api/vault/:slug', requireAuth, (req, res) => {
    const { slug } = req.params;
    const db = loadDB();

    if (db.vault && db.vault[slug]) {
        const metadata = db.vault[slug];
        const zipPath = metadata.filePath || path.join(VAULT_DIR, `${slug}.zip`);

        try {
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
            }
        } catch (err) {
            console.error(`[Plugin Vault Delete Error] Failed to delete file ${zipPath}:`, err.message);
        }

        delete db.vault[slug];
        saveDB(db);
        return res.json({ message: 'Plugin successfully deleted from vault.' });
    }

    return res.status(404).json({ error: 'Plugin not found in vault.' });
});

// Provide a way for testing script to retrieve VAULT_DB
app.get('/api/test/vault', (req, res) => {
    const db = loadDB();
    res.json(db.vault || {});
});

app.listen(PORT, () => {
    console.log(`Central Dashboard Backend listening at http://localhost:${PORT}`);
});
