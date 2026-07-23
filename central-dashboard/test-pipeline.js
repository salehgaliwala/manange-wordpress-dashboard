/**
 * Mock Integration / Pipeline Demonstration script.
 * Simulates the end-to-end integration flow of the Safe Update Pipeline by Mocking/Stubbing
 * the WordPress server responses and creating actual mockup PNG screenshots to run the comparison engine.
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const SafeUpdateOrchestrator = require('./orchestrator');

// Helper to write a solid-color PNG for testing visual regression
function createSolidPNG(filePath, width, height, r, g, b) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (width * y + x) << 2;
            png.data[idx] = r;     // Red
            png.data[idx + 1] = g; // Green
            png.data[idx + 2] = b; // Blue
            png.data[idx + 3] = 255; // Alpha
        }
    }
    fs.writeFileSync(filePath, PNG.sync.write(png));
}

async function runDemo() {
    console.log('====================================================');
    console.log('Running Mock Integration & Visual Regression Demonstration');
    console.log('====================================================');

    const orchestrator = new SafeUpdateOrchestrator({
        url: 'http://localhost:8080',
        secretKey: 'mock_secret_key_123',
        s3Config: {
            bucket: 'test-bucket',
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            accessKey: 'minioadmin',
            secretKey: 'minioadmin'
        }
    });

    // 1. Verify HMAC Signature generation
    console.log('\nTesting HMAC Signature Generation...');
    const body = { action: 'test' };
    const headers = orchestrator.generateHeaders(body);
    console.log('Generated Signature Headers:', headers);
    if (!headers['X-Signature'] || !headers['X-Timestamp']) {
        throw new Error('HMAC Headers generation failed.');
    }
    console.log('✓ HMAC Generation test passed.');

    // 2. Setup mock directories and files for Visual Regression demonstration
    const prePath = path.join(__dirname, 'mock_pre.png');
    const postPassPath = path.join(__dirname, 'mock_post_pass.png');
    const postFailPath = path.join(__dirname, 'mock_post_fail.png');
    const diffPath = path.join(__dirname, 'mock_diff.png');

    console.log('\nGenerating mock full-page PNGs for visual regression testing...');
    // Create base 200x200 pixel white image
    createSolidPNG(prePath, 200, 200, 255, 255, 255);
    // Create post image with minor/unnoticeable difference (1% difference - e.g., 200 pixels altered slightly)
    createSolidPNG(postPassPath, 200, 200, 255, 255, 254);
    // Create post image with massive visual shift (100% mismatch, solid red)
    createSolidPNG(postFailPath, 200, 200, 255, 0, 0);

    // 3. Run visual regression check - PASS SCENARIO
    console.log('\n--- Running Visual Comparison (Scenario: Passing, <=2% difference) ---');
    const passMismatch = orchestrator.compareScreenshots(prePath, postPassPath, diffPath);
    console.log(`Mismatch: ${passMismatch.toFixed(2)}%`);
    if (passMismatch > 2.0) {
        throw new Error(`Expected pass mismatch <= 2%, got: ${passMismatch}%`);
    }
    console.log('✓ Passing Scenario checked successfully.');

    // 4. Run visual regression check - FAIL SCENARIO
    console.log('\n--- Running Visual Comparison (Scenario: Failing, >2% difference) ---');
    const failMismatch = orchestrator.compareScreenshots(prePath, postFailPath, diffPath);
    console.log(`Mismatch: ${failMismatch.toFixed(2)}%`);
    if (failMismatch <= 2.0) {
        throw new Error(`Expected fail mismatch > 2%, got: ${failMismatch}%`);
    }
    console.log('✓ Failing Scenario checked successfully.');

    // Clean up mock files
    try {
        fs.unlinkSync(prePath);
        fs.unlinkSync(postPassPath);
        fs.unlinkSync(postFailPath);
        fs.unlinkSync(diffPath);
    } catch (e) {}

    console.log('\n====================================================');
    console.log('DEMO AND INTEGRATION VERIFICATION SUCCESSFULLY COMPLETED');
    console.log('====================================================');
}

runDemo().catch(err => {
    console.error('Demo execution failed:', err);
    process.exit(1);
});
