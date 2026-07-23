const crypto = require('crypto');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

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
        this.dashboardBaseUrl = siteConfig.dashboardBaseUrl || 'http://localhost:3002'; // Updated to default to port 3002 consistently
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
     * Capture a full-page visual screenshot using Puppeteer.
     */
    async captureScreenshot(outputPath) {
        console.log(`[Puppeteer] Launching browser to capture: ${this.siteUrl}`);
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        try {
            const page = await browser.newPage();
            // Wait until network is mostly idle to ensure asset loading finishes
            await page.goto(this.siteUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await page.setViewport({ width: 1440, height: 900 });

            // Capture entire scrollable page
            await page.screenshot({ path: outputPath, fullPage: true });
            console.log(`[Puppeteer] Saved screenshot to: ${outputPath}`);
        } finally {
            await browser.close();
        }
    }

    /**
     * Poll Job Status on Worker Plugin until backup process completes or fails.
     */
    async pollBackupStatus(jobId, intervalMs = 5000, timeoutMs = 600000) {
        console.log(`[Backup Poller] Polling status for job: ${jobId}`);
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await this.signedGet('/wp-json/wp-central/v1/job-status', { job_id: jobId });
                const job = response.data;
                console.log(`[Backup Poller] Status: ${job.status}, Progress: ${job.progress}%`);

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
     * Visual regression check of pre vs post screenshots.
     * @returns {number} Percentage mismatch (0 to 100)
     */
    compareScreenshots(prePath, postPath, diffPath) {
        console.log(`[Visual Comparison] Comparing ${prePath} and ${postPath}`);

        const img1 = PNG.sync.read(fs.readFileSync(prePath));
        const img2 = PNG.sync.read(fs.readFileSync(postPath));
        const { width, height } = img1;

        // Verify dimensions match
        if (img1.width !== img2.width || img1.height !== img2.height) {
            console.warn('[Visual Comparison] Warning: Pre and Post screenshots have different dimensions!');
            return 100;
        }

        const diff = new PNG({ width, height });

        const numDiffPixels = pixelmatch(
            img1.data,
            img2.data,
            diff.data,
            width,
            height,
            { threshold: 0.1 }
        );

        const totalPixels = width * height;
        const mismatchPercent = (numDiffPixels / totalPixels) * 100;

        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        console.log(`[Visual Comparison] Difference percentage: ${mismatchPercent.toFixed(2)}%`);
        console.log(`[Visual Comparison] Visual regression diff map saved to: ${diffPath}`);

        return mismatchPercent;
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
     * Performs a complete safe automated update sequence.
     *
     * @param {Object} updateParams Update payload, e.g., { type: 'plugin', plugins: ['akismet/akismet.php'] }
     */
    async executeSafeUpdate(updateParams) {
        console.log('\n=== Starting Safe Update Pipeline ===');
        const timestampSuffix = Date.now();
        const preScreenshot = path.join(__dirname, `screenshot_pre_${timestampSuffix}.png`);
        const postScreenshot = path.join(__dirname, `screenshot_post_${timestampSuffix}.png`);
        const diffScreenshot = path.join(__dirname, `screenshot_diff_${timestampSuffix}.png`);

        try {
            // STEP A: Trigger asynchronous backup on the remote plugin and poll for completion
            console.log('\n--- Step A: Triggering Remote Backup ---');
            const backupPayload = {
                s3_bucket: this.s3Config.bucket,
                s3_endpoint: this.s3Config.endpoint,
                s3_region: this.s3Config.region,
                s3_access_key: this.s3Config.accessKey,
                s3_secret_key: this.s3Config.secretKey
            };

            const backupInitResponse = await this.signedPost('/wp-json/wp-central/v1/backup', backupPayload);
            const { job_id } = backupInitResponse.data;
            console.log(`Backup accepted. Received Job ID: ${job_id}`);

            // Wait for non-blocking backup to upload to S3 successfully
            await this.pollBackupStatus(job_id);
            console.log('✓ Step A Completed. Backup uploaded securely to S3.');

            // STEP B: Visual snapshot (Pre-Update)
            console.log('\n--- Step B: Capturing Pre-Update Visual State ---');
            await this.captureScreenshot(preScreenshot);
            console.log('✓ Step B Completed.');

            // STEP C: Perform the update (Modifying payload for custom plugin vault matches)
            console.log('\n--- Step C: Dispatching Automated Core / Plugin Updates ---');

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
            console.log('✓ Step C Completed.');

            // STEP D: Visual snapshot (Post-Update)
            console.log('\n--- Step D: Capturing Post-Update Visual State ---');
            await this.captureScreenshot(postScreenshot);
            console.log('✓ Step D Completed.');

            // STEP E: Run visual regression calculations
            console.log('\n--- Step E: Executing Visual Regression Analysis ---');
            const mismatchPercent = this.compareScreenshots(preScreenshot, postScreenshot, diffScreenshot);

            if (mismatchPercent > 2.0) {
                console.error(`\n[CRITICAL ALERT] Visual mismatch is ${mismatchPercent.toFixed(2)}%, exceeding the 2% threshold.`);
                console.error('Action: Flagging site for manual review and staging rollback rollback procedures!');
                return {
                    success: false,
                    reason: 'Visual regression threshold exceeded',
                    mismatchPercent,
                    preScreenshot,
                    postScreenshot,
                    diffScreenshot
                };
            }

            console.log(`\n✓ Safe Update Finished successfully! Visual mismatch: ${mismatchPercent.toFixed(2)}% is within limits.`);
            return {
                success: true,
                mismatchPercent,
                preScreenshot,
                postScreenshot
            };

        } catch (error) {
            console.error('\n[FATAL PIPELINE FAILURE]', error.message);
            if (error.response) {
                console.error('Server responded with:', error.response.status, error.response.data);
            }
            throw error;
        }
    }
}

module.exports = SafeUpdateOrchestrator;
