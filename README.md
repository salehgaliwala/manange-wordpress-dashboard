# Central WordPress Management System

A highly secure, robust, and scalable API-based "Worker Plugin" architecture designed to manage multiple remote WordPress sites from a single centralized dashboard.

The system is composed of two primary components:
1. **Lightweight WordPress Worker Plugin (`wp-worker-plugin/`)**: An API endpoint provider installed on each target WordPress site.
2. **Central Dashboard Backend (`central-dashboard/`)**: A Node.js control center coordinating backups, visual regression screenshots, core/plugin updates, premium custom plugin vault storage, and automated rollback actions.

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

### 3. "Safe Update" Pipeline & Premium Plugin Vault (Dashboard Orchestration)
The central orchestrator automates a zero-downtime, safe update workflow across target sites:
- **Step A (Remote Backup)**: Triggers the background backup and polls `/job-status` until the S3 upload completes.
- **Step B (Pre-Screenshot)**: Automates a headless browser (Puppeteer) to snapshot the site's original full-page state.
- **Step C (Run Update & Vault Sideload)**:
  - Commands the worker plugin to apply WordPress Core or selected plugin upgrades using native WP administrative Upgrader classes.
  - **Premium Vault Sideload**: If updating a custom or premium plugin, the dashboard automatically parses the `.zip` file, extracts metadata headers, registers the slug, signs a secure pre-signed download token, and injects a `package_url` payload. The worker plugin downloads this custom package securely via `download_url()` and overwrites/installs the plugin.
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
│   ├── test-vault.js            # Premium/Custom Plugin Vault integration test (Node.js)
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

### 3. Uploading Premium Plugins to Vault
To upload a custom or premium plugin `.zip` package:
- **Endpoint**: `POST /api/plugins/upload`
- **Headers**:
  ```http
  Authorization: Bearer <your_token_here>
  ```
- **Multipart Form-data**: File field `plugin` mapping to your `.zip` archive.
- **Response**:
  ```json
  {
    "message": "Plugin successfully uploaded, parsed, and vaulted.",
    "plugin": {
      "name": "My Premium Plugin",
      "slug": "my-premium-plugin",
      "version": "1.2.3",
      "author": "Awesome Team",
      "uploadedAt": "2026-07-23T17:25:35.117Z"
    }
  }
  ```

---

## Running Integration & Pipeline Tests

Two pre-packaged demonstration suites are included to verify security signature logic and custom sideloading flows end-to-end:

### Test Safe Update & Visual Regression Comparison:
```bash
cd central-dashboard
npm run test-pipeline
```

### Test Premium Plugin Vault, Zip Parsing, and Pre-Signed Sideload download:
```bash
cd central-dashboard
node test-vault.js
```
