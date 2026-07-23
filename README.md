# Central WordPress Management System

A highly secure, robust, and scalable API-based "Worker Plugin" architecture designed to manage multiple remote WordPress sites from a single centralized dashboard.

The system is composed of two primary components:
1. **Lightweight WordPress Worker Plugin (`wp-worker-plugin/`)**: An API endpoint provider installed on each target WordPress site.
2. **Central Dashboard Backend (`central-dashboard/`)**: A Node.js control center coordinating backup, visual regression screenshots, core/plugin updates, and automated rollback actions.

---

## System Architecture & Features

### 1. Security & Authentication (Worker Plugin)
- **HMAC-SHA256 Signatures**: All custom REST API routes under the `wp-central/v1` namespace are protected. Requests must provide a signature generated with a shared secret key.
- **Replay Attack Prevention**:
  - Rejects any requests older than 5 minutes (300 seconds) via a timestamp validation window (`X-Timestamp`).
  - Tracks incoming requests using transients to guarantee each signature is used exactly once.
- **Timing Attack Resistance**: Uses PHP's native timing-safe `hash_equals` function to evaluate signatures.

### 2. Asynchronous S3-Compatible Backup Engine
- **Non-blocking Loopback Process**: A request to `POST /backup` returns `202 Accepted` immediately with a unique Job ID. The plugin triggers an internal asynchronous loopback POST (`/backup-process`) in the background.
- **Pure-PHP SQL Export**: Dumps the complete WordPress database layout and record queries without depending on external binaries like `mysqldump`.
- **Zip Compression**: Archives the whole `/wp-content/` directory recursively. Prevents infinite loops by explicitly excluding the active temporary backup workspace.
- **AWS Signature V4 REST Client**: Built-in, zero-dependency lightweight S3 client in PHP. Streams and uploads backup archives directly to any S3-compatible cloud storage endpoint (AWS, MinIO, DigitalOcean Spaces, etc.) securely.

### 3. "Safe Update" Pipeline (Dashboard Orchestration)
The central orchestrator automates a zero-downtime, safe update workflow across target sites:
- **Step A (Remote Backup)**: Triggers the background backup and polls `/job-status` until the S3 upload completes.
- **Step B (Pre-Screenshot)**: Automates a headless browser (Puppeteer) to snapshot the site's original full-page state.
- **Step C (Run Update)**: Commands the worker plugin to apply WordPress Core or selected plugin upgrades using native WP administrative Upgrader classes.
- **Step D (Post-Screenshot)**: Captures a secondary post-update screenshot of the live site.
- **Step E (Visual Regression Analysis)**: Compares the pre- and post-screenshots pixel-by-pixel using `pixelmatch`. If the mismatch exceeds **2%**, it logs a high-severity alert, flags the site for manual review, or triggers a rollback.

---

## Repository Structure

```
.
├── wp-worker-plugin/
│   └── wp-worker-plugin.php     # WordPress lightweight worker plugin (PHP)
├── central-dashboard/
│   ├── orchestrator.js          # Core Safe Update orchestrator class (Node.js)
│   ├── server.js                # Protected Express REST server with JWT/Bearer login (Node.js)
│   ├── test-pipeline.js         # Integration test/mock visual regression runner (Node.js)
│   └── package.json             # Node dependencies and scripts
└── README.md                    # System documentation
```

---

## Installation & Setup

### 1. WordPress Worker Plugin Setup
1. Zip or upload the directory `wp-worker-plugin/` into your WordPress installation's `/wp-content/plugins/` directory.
2. Activate the plugin **WP Central Worker Plugin** from your WordPress Admin dashboard.
3. Define your shared HMAC secret key in your WordPress `wp-config.php`:
   ```php
   define('WP_CENTRAL_SECRET_KEY', 'your_secure_shared_secret_key_here');
   ```

### 2. Central Dashboard Installation
1. Navigate to the dashboard directory:
   ```bash
   cd central-dashboard
   ```
2. Install the required Node.js dependencies:
   ```bash
   npm install
   ```
3. Set your preferred admin credentials for the dashboard inside your environment variables:
   ```bash
   export DASHBOARD_ADMIN_USER="admin"
   export DASHBOARD_ADMIN_PASS="SecurePassword123"
   ```

---

## Usage Guide & API Documentation

### 1. Starting the Central Dashboard Server
Run the production Express server:
```bash
npm start
```
By default, the server will start listening on `http://localhost:3000`.

### 2. Authenticating/Login to Dashboard
The central dashboard is fully protected. Before making requests to execute safe updates, obtain a secure bearer token:

- **Endpoint**: `POST /api/login`
- **Request Body**:
  ```json
  {
    "username": "admin",
    "password": "SecurePassword123"
  }
  ```
- **Response**:
  ```json
  {
    "message": "Authentication successful.",
    "token": "YWRtaW46MTc4NDgyMzUzOS41Zjg5YmNmMmNlMzBkZDc1NDU4NTU4NzIyNGU4OWIyMTI0ZjA2NWI2NTMyMGYyZjYxZDM1NzU0Njc4MzVlZTlk"
  }
  ```

Store this token and append it to the HTTP Headers of all protected orchestrator routes:
```http
Authorization: Bearer <your_token_here>
```

### 3. Orchestrating a Safe Update
Trigger the "Safe Update" pipeline of any registered target site:

- **Endpoint**: `POST /api/sites/:siteId/safe-update`
- **Headers**:
  ```http
  Authorization: Bearer <your_token_here>
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "type": "plugin",
    "plugins": ["akismet/akismet.php"]
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "mismatchPercent": 0.00,
    "preScreenshot": "/app/central-dashboard/screenshot_pre_1784823539.png",
    "postScreenshot": "/app/central-dashboard/screenshot_post_1784823539.png"
  }
  ```

---

## Running Integration & Pipeline Tests

A pre-packaged demonstration suite is included to simulate and test HMAC signature security and Puppeteer visual comparisons end-to-end:

1. Navigate to the `central-dashboard/` folder:
   ```bash
   cd central-dashboard
   ```
2. Execute the test:
   ```bash
   npm run test-pipeline
   ```
This script will:
- Verify that standard HMAC-SHA256 signature headers are generated correctly.
- Generate mock pixel layouts simulating both successful updates (visual difference $\leq$ 2%) and failed visual regression states (difference $>$ 2%).
- Run pixel-match comparison algorithms over the mock snapshots to verify automated fail-safes.
