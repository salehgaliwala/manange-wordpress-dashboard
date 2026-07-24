const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Orchestrator class representing the Core Central Dashboard logic and its Safe Update Pipeline.
 */
class SafeUpdateOrchestrator {

    /**
     * @param {Object} siteConfig
     * @param {string} siteConfig.url Target WordPress site base URL (e.g., 'https://example.com')
     * @param {string} siteConfig.secretKey Shared secret key for HMAC signature
     * @param {Object} siteConfig.s3Config Configuration for WP's S3 backup storage
     * @param {string} [siteConfig.dashboardBaseUrl] Base URL of the dashboard for pre-signed packages (e.g., 'http://localhost:3002')
     */
    constructor(siteConfig) {
        this.siteUrl = siteConfig.url.replace(/\/$/, '');
        this.secretKey = siteConfig.secretKey;
        this.s3Config = siteConfig.s3Config;
        this.dashboardBaseUrl = siteConfig.dashboardBaseUrl || 'http://localhost:3002';
    }

    /**
     * Generates standard HMAC-SHA256 headers for authentication.
     * @param {Object} body The request body payload to be serialized
     * @returns {Object} Headers with X-Signature and X-Timestamp
     */
    generateHeaders(body) {
        const timestamp = Math.floor(Date.now() / 1000);
        const serializedBody = typeof body === 'string' ? body : JSON.stringify(body || {});

        // Reconstruct the sign signature format
        const dataToSign = `${timestamp}.${serializedBody}`;
        const signature = crypto
            .createHmac('sha256', this.secretKey)
            .update(dataToSign)
            .digest('hex');

        return {
            'X-Timestamp': timestamp.toString(),
            'X-Signature': signature,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Helper to perform a signed HTTP POST request to the WordPress target plugin.
     */
    async signedPost(endpoint, data) {
        const url = `${this.siteUrl}${endpoint}`;
        const headers = this.generateHeaders(data);
        return axios.post(url, data, { headers });
    }

    /**
     * Helper to perform a signed HTTP GET request to the WordPress target plugin.
     */
    async signedGet(endpoint, params = {}) {
        const url = `${this.siteUrl}${endpoint}`;
        const headers = this.generateHeaders('');
        return axios.get(url, { headers, params });
    }

    /**
     * Poll Job Status on Worker Plugin until backup process completes or fails.
     */
    async pollBackupStatus(jobId, onStep, intervalMs = 2500, timeoutMs = 600000) {
        console.log(`[Backup Poller] Polling status for job: ${jobId}`);
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await this.signedGet('/wp-json/wp-central/v1/job-status', { job_id: jobId });
                const job = response.data;
                console.log(`[Backup Poller] Status: ${job.status}, Progress: ${job.progress}%`);

                if (onStep) {
                    // Map the 0-100% remote progress to a 25-70% dashboard progress slice
                    const dashboardProgress = Math.round(25 + (job.progress * 0.45));
                    let stepMsg = `Exporting databases and archiving entire /wp-content/ directory (${job.progress}%)...`;
                    if (job.status === 'completed') {
                        stepMsg = `Securing archive to final destination...`;
                    }
                    onStep(dashboardProgress, stepMsg);
                }

                if (job.status === 'completed') {
                    return job;
                }
                if (job.status === 'failed') {
                    throw new Error(`Backup worker failed with error: ${job.error}`);
                }
            } catch (err) {
                console.warn(`[Backup Poller] Warn: Status poll failed temporarily. Error: ${err.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        throw new Error('Backup polling reached maximum timeout limit.');
    }

    /**
     * Helper to extract a slug from a plugin filepath string (e.g., 'akismet/akismet.php' -> 'akismet')
     */
    getPluginSlug(pluginFile) {
        if (!pluginFile) return '';
        const parts = pluginFile.split('/');
        return parts[0];
    }

    /**
     * Generates a short-lived download token using HMAC.
     * @param {string} slug
     * @returns {string} Token containing expiration and signature
     */
    generateDownloadToken(slug) {
        const expires = Math.floor(Date.now() / 1000) + 900; // 15 minutes expiration
        const dataToSign = `${slug}:${expires}`;
        const signature = crypto
            .createHmac('sha256', this.secretKey)
            .update(dataToSign)
            .digest('hex');
        return Buffer.from(`${expires}:${signature}`).toString('base64');
    }

    /**
     * Orchestrator execution entry point.
     * Performs an automated update sequence with pre-update backup step.
     *
     * @param {Object} updateParams Update payload, e.g., { type: 'plugin', plugins: ['akismet/akismet.php'] }
     * @param {Function} [onStep] Progress callback function
     */
    async executeSafeUpdate(updateParams, onStep) {
        console.log('\n=== Starting Safe Update Pipeline ===');

        try {
            if (onStep) onStep(10, 'Initializing Pipeline Connection...');

            // STEP A: Trigger asynchronous backup on the remote plugin and poll for completion
            console.log('\n--- Step A: Triggering Remote Backup ---');
            if (onStep) onStep(20, 'Triggering target backup execution on target...');

            const backupPayload = {
                backup_destination: updateParams.backup_destination || 's3',
                s3_bucket: this.s3Config.bucket,
                s3_endpoint: this.s3Config.endpoint,
                s3_region: this.s3Config.region,
                s3_access_key: this.s3Config.accessKey,
                s3_secret_key: this.s3Config.secretKey
            };

            const backupInitResponse = await this.signedPost('/wp-json/wp-central/v1/backup', backupPayload);
            const { job_id } = backupInitResponse.data;
            console.log(`Backup accepted. Received Job ID: ${job_id}`);

            // Wait for non-blocking backup to upload successfully
            const backupJob = await this.pollBackupStatus(job_id, onStep);
            console.log('✓ Step A Completed. Backup created successfully.');

            if (onStep) onStep(75, 'Securing archive and preparing update payload...');

            // STEP B: Perform the update (Modifying payload for custom plugin vault matches)
            console.log('\n--- Step B: Dispatching Automated Core / Plugin Updates ---');
            if (onStep) onStep(85, 'Dispatching direct Core / Plugin update upgrader routines...');

            let finalUpdatePayload = { ...updateParams };

            if (updateParams.type === 'plugin' && Array.isArray(updateParams.plugins)) {
                const enrichedPlugins = [];

                for (const plugin of updateParams.plugins) {
                    let slug = '';
                    let fileIdentifier = '';

                    if (typeof plugin === 'string') {
                        slug = this.getPluginSlug(plugin);
                        fileIdentifier = plugin;
                    } else if (plugin && typeof plugin === 'object') {
                        fileIdentifier = plugin.file;
                        slug = plugin.slug || this.getPluginSlug(fileIdentifier);
                    }

                    const vaultDir = path.join(__dirname, 'vault');
                    const zipPath = path.join(vaultDir, `${slug}.zip`);

                    let pluginDataEntry = { file: fileIdentifier };

                    // If a matching .zip package exists in our Plugin Vault
                    if (fs.existsSync(zipPath)) {
                        console.log(`[Plugin Vault] Found custom package for slug: ${slug}`);
                        // Generate secure, short-lived download token
                        const secureToken = this.generateDownloadToken(slug);
                        const packageUrl = `${this.dashboardBaseUrl}/api/plugins/download/${slug}?token=${secureToken}`;

                        pluginDataEntry.package_url = packageUrl;
                        console.log(`[Plugin Vault] Appended package_url: ${packageUrl}`);
                    }

                    enrichedPlugins.push(pluginDataEntry);
                }

                finalUpdatePayload.plugins = enrichedPlugins;
            }

            const updateResponse = await this.signedPost('/wp-json/wp-central/v1/update', finalUpdatePayload);
            console.log(`Update Result Message: ${updateResponse.data.message}`);

            if (onStep) onStep(100, `✓ Pipeline complete! Node updated directly and safely.`);
            console.log('✓ Step B Completed.');

            console.log('\n✓ Automated Update Pipeline finished successfully!');
            return {
                success: true,
                message: updateResponse.data.message,
                backup_path: backupJob.local_backup_path || backupJob.archive_name || 'Cloud S3 Bucket'
            };

        } catch (error) {
            console.error('\n[FATAL PIPELINE FAILURE]', error.message);
            if (error.response) {
                console.error('Server responded with:', error.response.status, error.response.data);
            }
            if (onStep) onStep(0, `⚠️ Pipeline failed: ${error.message}`);
            throw error;
        }
    }
}

module.exports = SafeUpdateOrchestrator;
