/**
 * Automated Backup Scheduling and UpdraftPlus-style Auto-Pruning Integration Test Suite.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function runSchedulerTest() {
    console.log('====================================================');
    console.log('Running Backup Scheduling & Auto-Pruning Test Suite');
    console.log('====================================================');

    // Spin up local Express server on port 3002 for test
    process.env.PORT = '3002';
    require('./server.js');

    // Wait for Express to bind
    await new Promise(resolve => setTimeout(resolve, 1000));

    const baseUrl = 'http://localhost:3002';

    try {
        // 1. Log in to fetch token
        console.log('\nLogging in to Dashboard...');
        const loginRes = await axios.post(`${baseUrl}/api/login`, {
            username: 'admin@example.com',
            password: 'SecurePassword123'
        });
        const token = loginRes.data.token;
        const authHeader = { 'Authorization': `Bearer ${token}` };
        console.log('✓ Logged in successfully.');

        // 2. Fetch current backup config
        console.log('\nFetching current backup configuration...');
        const configRes = await axios.get(`${baseUrl}/api/sites/example-wp-site/backup-config`, { headers: authHeader });
        console.log('Current Config:', configRes.data.backupConfig);
        console.log('History count:', configRes.data.backupHistory.length);

        // 3. Configure daily schedule with a tight retention policy (keep only 2 scheduled backups)
        console.log('\nUpdating backup configuration with Daily frequency and retention of 2...');
        const updateRes = await axios.post(`${baseUrl}/api/sites/example-wp-site/backup-config`, {
            scheduleEnabled: true,
            frequency: 'daily',
            timeOfDay: '03:00',
            retainDbCount: 2,
            retainFilesCount: 2,
            destination: 'local'
        }, { headers: authHeader });

        console.log('Updated Config:', updateRes.data.backupConfig);
        if (!updateRes.data.backupConfig.scheduleEnabled || updateRes.data.backupConfig.nextRunTimestamp === null) {
            throw new Error('Config update failed. Schedule not enabled or nextRunTimestamp missing.');
        }
        console.log('✓ Backup schedule configured successfully.');

        // 4. Test Manual "Backup Now" trigger
        console.log('\nTriggering a manual backup...');
        const manualRes = await axios.post(`${baseUrl}/api/sites/example-wp-site/backup-now`, {
            destination: 'local',
            scope: 'full'
        }, { headers: authHeader });
        console.log('Manual Trigger Response:', manualRes.data);
        if (!manualRes.data.backupId) {
            throw new Error('Manual backup trigger failed.');
        }

        // Wait a bit and check history
        await new Promise(resolve => setTimeout(resolve, 500));
        let historyRes = await axios.get(`${baseUrl}/api/sites/example-wp-site/backup-config`, { headers: authHeader });
        console.log('History registry count after manual backup:', historyRes.data.backupHistory.length);
        const hasManual = historyRes.data.backupHistory.some(h => h.type === 'manual');
        if (!hasManual) {
            throw new Error('Manual backup did not register in history.');
        }
        console.log('✓ Manual backup successfully registered.');

        // 5. Simulate Scheduled Backup execution & auto-pruning
        console.log('\nSimulating scheduled backup triggers...');
        // Let's populate mock completed scheduled backups in database to test pruning
        const dbPath = path.join(__dirname, 'data.json');
        const dbContent = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        const siteIdx = dbContent.sites.findIndex(s => s.id === 'example-wp-site');

        // Insert 4 mock completed scheduled backups (exceeding our retain limit of 2)
        dbContent.sites[siteIdx].backupHistory = [
            {
                backupId: "bak_manual_existing",
                timestamp: "2026-07-28T01:00:00Z",
                type: "manual",
                scope: "full",
                destination: "local",
                status: "completed",
                fileSize: "350 MB"
            },
            {
                backupId: "bak_sched_1",
                timestamp: "2026-07-28T02:00:00Z",
                type: "scheduled",
                scope: "full",
                destination: "local",
                status: "completed",
                fileSize: "350 MB"
            },
            {
                backupId: "bak_sched_2",
                timestamp: "2026-07-28T03:00:00Z",
                type: "scheduled",
                scope: "full",
                destination: "local",
                status: "completed",
                fileSize: "350 MB"
            },
            {
                backupId: "bak_sched_3",
                timestamp: "2026-07-28T04:00:00Z",
                type: "scheduled",
                scope: "full",
                destination: "local",
                status: "completed",
                fileSize: "350 MB"
            },
            {
                backupId: "bak_sched_4",
                timestamp: "2026-07-28T05:00:00Z",
                type: "scheduled",
                scope: "full",
                destination: "local",
                status: "completed",
                fileSize: "350 MB"
            }
        ];

        fs.writeFileSync(dbPath, JSON.stringify(dbContent, null, 2), 'utf8');
        console.log('Mock backup logs loaded into database. Total entries:', dbContent.sites[siteIdx].backupHistory.length);

        // Call our test schedule trigger route to run check and prune
        console.log('\nTriggering database scheduler auto-prune routine...');
        await axios.post(`${baseUrl}/api/test/trigger-scheduler`, {}, { headers: authHeader });

        // Fetch history and verify pruning
        historyRes = await axios.get(`${baseUrl}/api/sites/example-wp-site/backup-config`, { headers: authHeader });
        const finalHistory = historyRes.data.backupHistory;
        console.log('Final History registry after pruning:', finalHistory);

        // Verify that we kept the manual one
        const manualKept = finalHistory.some(h => h.backupId === 'bak_manual_existing');
        if (!manualKept) {
            throw new Error('Safety Gate Violation: Manual backup was incorrectly pruned!');
        }
        console.log('✓ Safety Gate Verified: Manual backups are completely protected from pruning.');

        // Verify that we only kept 2 scheduled backups (bak_sched_3 and bak_sched_4, the newest ones)
        const keptScheduled = finalHistory.filter(h => h.type === 'scheduled');
        console.log('Kept Scheduled Backups:', keptScheduled);
        if (keptScheduled.length > 2) {
            throw new Error(`Pruner failed. Expected max 2 scheduled backups, got ${keptScheduled.length}`);
        }
        const hasOld = keptScheduled.some(h => h.backupId === 'bak_sched_1' || h.backupId === 'bak_sched_2');
        if (hasOld) {
            throw new Error('Old scheduled backups were not correctly pruned.');
        }
        console.log('✓ UpdraftPlus Auto-Pruning Verified: Old scheduled backups successfully pruned to target limit.');

        // 6. Test Manual Archive Deletion via DELETE endpoint
        console.log('\nTesting manual backup deletion endpoint (DELETE /api/sites/:siteId/backups/:backupId)...');
        const deleteRes = await axios.delete(`${baseUrl}/api/sites/example-wp-site/backups/bak_sched_3`, { headers: authHeader });
        console.log('Delete Response:', deleteRes.data);

        historyRes = await axios.get(`${baseUrl}/api/sites/example-wp-site/backup-config`, { headers: authHeader });
        const hasDeletedId = historyRes.data.backupHistory.some(h => h.backupId === 'bak_sched_3');
        if (hasDeletedId) {
            throw new Error('Backup bak_sched_3 was not deleted from database registry.');
        }
        console.log('✓ Manual archive deletion and registry untracking verified.');

        console.log('\n====================================================');
        console.log('BACKUP SCHEDULING & RETENTION VERIFIED SUCCESSFULLY!');
        console.log('====================================================');
        process.exit(0);

    } catch (err) {
        console.error('Backup scheduling test failed:', err.message);
        if (err.response) {
            console.error('Response data:', err.response.data);
        }
        process.exit(1);
    }
}

runSchedulerTest();
