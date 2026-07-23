const express = require('express');
const SafeUpdateOrchestrator = require('./orchestrator');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
 * Endpoint to trigger a safe update pipeline for a registered WordPress site
 * POST /api/sites/:siteId/safe-update
 */
app.post('/api/sites/:siteId/safe-update', async (req, res) => {
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
        // Run orchestrator asynchronously so we can return quickly,
        // or await here to respond with pipeline results.
        const result = await orchestrator.executeSafeUpdate({ type, plugins });
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json({
            error: 'Safe update pipeline failed to execute fully.',
            message: err.message
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'WP Central Dashboard' });
});

app.listen(PORT, () => {
    console.log(`Central Dashboard Backend listening at http://localhost:${PORT}`);
});
