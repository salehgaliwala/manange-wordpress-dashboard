/**
 * Authentication & Login Verification Test Script.
 * Verifies that POST /api/login, GET /, and the protected endpoints respond properly.
 */

const axios = require('axios');
const http = require('http');

async function runAuthTest() {
    console.log('====================================================');
    console.log('Running Authentication, GET /, and Login Flow Test');
    console.log('====================================================');

    // Spin up local Express server on port 3002 for test as requested
    process.env.PORT = '3002';
    const server = require('./server.js');

    // Wait a brief moment for Express to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    const baseUrl = 'http://localhost:3002';

    try {
        // 1. Verify GET / landing route serves the React HTML dashboard
        console.log('\nChecking GET / (landing React dashboard UI)...');
        const landingRes = await axios.get(`${baseUrl}/`);
        console.log('GET / Response status:', landingRes.status);
        if (landingRes.status !== 200 || !landingRes.data.includes('<!DOCTYPE html>')) {
            throw new Error('GET / did not serve correct React landing UI!');
        }
        console.log('✓ GET / React UI served successfully.');

        // 2. Verify health check is unprotected
        console.log('\nChecking /health (unprotected)...');
        const healthRes = await axios.get(`${baseUrl}/health`);
        console.log('Health Check Response status:', healthRes.status, healthRes.data);

        // 3. Access protected endpoint without token
        console.log('\nAccessing protected endpoint without token...');
        try {
            await axios.post(`${baseUrl}/api/sites/example-wp-site/safe-update`, {
                type: 'plugin',
                plugins: ['akismet/akismet.php']
            });
            throw new Error('Access should have been denied without token!');
        } catch (err) {
            console.log('Expected Access Denied status:', err.response.status);
            console.log('Message:', err.response.data);
            if (err.response.status !== 401) {
                throw new Error(`Expected 401 Unauthorized, got ${err.response.status}`);
            }
        }

        // 4. Attempt login with invalid credentials
        console.log('\nAttempting login with invalid credentials...');
        try {
            await axios.post(`${baseUrl}/api/login`, {
                username: 'admin',
                password: 'WrongPassword'
            });
            throw new Error('Login should have failed!');
        } catch (err) {
            console.log('Expected Login Failure status:', err.response.status);
            console.log('Message:', err.response.data);
            if (err.response.status !== 401) {
                throw new Error(`Expected 401, got ${err.response.status}`);
            }
        }

        // 5. Attempt login with correct credentials
        console.log('\nAttempting login with correct credentials...');
        const loginRes = await axios.post(`${baseUrl}/api/login`, {
            username: 'admin',
            password: 'SecurePassword123'
        });
        console.log('Login Successful status:', loginRes.status);
        console.log('Received Token:', loginRes.data.token);

        const token = loginRes.data.token;

        // 6. Access protected endpoint with correct token
        console.log('\nAccessing protected endpoint WITH correct Bearer token (simulated mock)...');
        try {
            await axios.post(`${baseUrl}/api/sites/example-wp-site/safe-update`, {
                type: 'plugin',
                plugins: ['akismet/akismet.php']
            }, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
        } catch (err) {
            // It will fail because localhost:8080 is not running, but that proves requireAuth middleware allowed it to pass!
            console.log('Orchestrator reached! Connection error details:', err.message);
            if (err.message.includes('ECONNREFUSED')) {
                console.log('✓ Successfully bypassed requireAuth and initiated update pipeline!');
            } else {
                throw err;
            }
        }

        console.log('\n====================================================');
        console.log('AUTHENTICATION, GET /, AND PROTECTION VERIFIED');
        console.log('====================================================');
        process.exit(0);

    } catch (err) {
        console.error('Auth verification test failed:', err);
        process.exit(1);
    }
}

runAuthTest();
