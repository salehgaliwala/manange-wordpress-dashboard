const axios = require('axios');

async function test() {
    try {
        const loginRes = await axios.post('http://localhost:3002/api/login', {
            username: 'admin@example.com',
            password: 'SecurePassword123'
        });
        const token = loginRes.data.token;
        console.log('Login token:', token);

        const configRes = await axios.get('http://localhost:3002/api/sites/example-wp-site/backup-config', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('Config status:', configRes.status);
        console.log('Config response data:', configRes.data);
        process.exit(0);
    } catch (err) {
        console.error('Error fetching config:', err.message);
        if (err.response) {
            console.error('Status:', err.response.status, err.response.data);
        }
        process.exit(1);
    }
}

// Start server
process.env.PORT = '3002';
require('./server.js');

setTimeout(test, 1000);
