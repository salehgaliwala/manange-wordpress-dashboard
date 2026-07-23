const express = require('express');
const crypto = require('crypto');
const SafeUpdateOrchestrator = require('./orchestrator');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuration and credentials
const ADMIN_CREDENTIALS = {
    username: process.env.DASHBOARD_ADMIN_USER || 'admin',
    passwordHash: crypto.createHash('sha256').update(process.env.DASHBOARD_ADMIN_PASS || 'SecurePassword123').digest('hex')
};

// Simple secret used to sign session tokens locally
const TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
const ACTIVE_TOKENS = new Set();

// Demo/In-memory store of registered client sites
const SITES_DB = {
    'example-wp-site': {
        url: 'http://localhost:8080', // Default local WP instance port
        secretKey: 'wp_central_shared_secret_key_999',
        s3Config: {
            bucket: 'wp-backups-bucket',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            region: 'us-east-1',
            accessKey: 'MOCK_S3_ACCESS_KEY',
            secretKey: 'MOCK_S3_SECRET_KEY'
        }
    }
};

/**
 * Authentication Middleware
 * Validates the Authorization Bearer token.
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access Denied. No authorization header or Bearer token provided.' });
    }

    const token = authHeader.split(' ')[1];

    // Validate token exists in our active sessions store
    if (!ACTIVE_TOKENS.has(token)) {
        return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }

    next();
}

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
        // Generate secure session token
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
 * Protected Endpoint to trigger a safe update pipeline for a registered WordPress site
 * POST /api/sites/:siteId/safe-update
 * Protected by requireAuth
 */
app.post('/api/sites/:siteId/safe-update', requireAuth, async (req, res) => {
    const { siteId } = req.params;
    const { type, plugins } = req.body; // e.g., type: 'plugin', plugins: ['akismet/akismet.php']

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

app.listen(PORT, () => {
    console.log(`Central Dashboard Backend listening at http://localhost:${PORT}`);
});
