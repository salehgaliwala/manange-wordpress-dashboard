import React, { useState } from 'react';
import SitesTable from '../components/SitesTable';
import PluginVaultUpload from '../components/PluginVaultUpload';
import SafeUpdateProgress from '../components/SafeUpdateProgress';

/**
 * Main Central Dashboard landing view.
 * Synthesizes Overview Cards, Sites Tables, Plugin Upload Panels, and Real-Time Pipeline logs.
 */
export default function Dashboard() {
    const [mockSites, setSites] = useState([
        { id: '1', name: 'Alpha Blog', url: 'https://site-alpha.com', wpVersion: '6.4.2', pendingUpdates: 4, lastBackupStatus: 'success', lastBackupTime: '2 hrs ago' },
        { id: '2', name: 'Omega Shop', url: 'https://site-omega.com', wpVersion: '6.3.1', pendingUpdates: 0, lastBackupStatus: 'success', lastBackupTime: '1 day ago' },
        { id: '3', name: 'Beta Agency', url: 'https://site-beta.com', wpVersion: '6.4.2', pendingUpdates: 12, lastBackupStatus: 'fail', lastBackupTime: '3 days ago' }
    ]);

    const [activeJobId, setActiveJobId] = useState(null);
    const [vaultPlugins, setVaultPlugins] = useState([
        { name: 'Sideload Security Suite', slug: 'sideload-security-suite', version: '4.1.2', author: 'WP Vault Devs' },
        { name: 'Custom WooCommerce Optimizer', slug: 'custom-woo-optimizer', version: '1.0.5', author: 'Retail Corp' }
    ]);

    const handleUploadSuccess = (newPlugin) => {
        setVaultPlugins(prev => [newPlugin, ...prev]);
    };

    const triggerMockSafeUpdate = () => {
        setActiveJobId('job_custom_' + Date.now());
    };

    // Summary calculations
    const sitesCount = mockSites.length;
    const updatesNeeded = mockSites.filter(s => s.pendingUpdates > 0).length;
    const failedBackups = mockSites.filter(s => s.lastBackupStatus === 'fail').length;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            {/* Nav Header */}
            <header className="bg-slate-900 border-b border-slate-800 py-4 px-8 flex justify-between items-center shadow-lg">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center font-bold text-white shadow-lg shadow-violet-500/20 text-lg">
                        W
                    </div>
                    <div>
                        <h1 className="text-base font-black text-white tracking-tight uppercase">WP Central Dashboard</h1>
                        <p className="text-[10px] text-slate-500 font-mono tracking-widest font-semibold">FOUNDATIONAL FRONTEND UI</p>
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <span className="text-xs font-mono text-slate-400 bg-slate-950 px-3 py-1.5 rounded-full border border-slate-800">
                        🔑 Admin Mode
                    </span>
                    <button
                        onClick={() => alert('Logged out successfully.')}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs px-4 py-2 rounded-lg transition"
                    >
                        Sign Out
                    </button>
                </div>
            </header>

            {/* Layout Grid */}
            <main className="max-w-7xl mx-auto p-8 space-y-8 animate-fadeIn">
                {/* 1. High-Level Overview Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Connected Nodes</span>
                        <span className="text-3xl font-black text-white mt-2 block">{sitesCount}</span>
                        <p className="text-xs text-slate-400 mt-2">Target sites active with worker plugins</p>
                        <div className="absolute right-4 bottom-4 text-3xl opacity-10">🌐</div>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Sites Needing Updates</span>
                        <span className="text-3xl font-black text-amber-400 mt-2 block">{updatesNeeded}</span>
                        <p className="text-xs text-slate-400 mt-2">Awaiting automated visual pipeline updates</p>
                        <div className="absolute right-4 bottom-4 text-3xl opacity-10">⚡</div>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Failed Backups</span>
                        <span className={`text-3xl font-black mt-2 block ${failedBackups > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {failedBackups}
                        </span>
                        <p className="text-xs text-slate-400 mt-2">Backups failing to stream directly to S3</p>
                        <div className="absolute right-4 bottom-4 text-3xl opacity-10">💾</div>
                    </div>
                </div>

                {/* 2. Safe Update Live Queue widget trigger */}
                {activeJobId && (
                    <div className="animate-fadeIn">
                        <SafeUpdateProgress
                            jobId={activeJobId}
                            onFinished={() => console.log('Mock safe update completed')}
                        />
                    </div>
                )}

                {/* 3. Global Sites Table */}
                <div>
                    <SitesTable initialSites={mockSites} />
                </div>

                {/* 4. Bottom Grid (Plugin Vault Upload & Vault Inventory) */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div>
                        <PluginVaultUpload onUploadSuccess={handleUploadSuccess} />
                    </div>

                    {/* Vault inventory */}
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl flex flex-col justify-between">
                        <div>
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-lg font-bold text-white">Sideload Vault Inventory ({vaultPlugins.length})</h3>
                                <button
                                    onClick={triggerMockSafeUpdate}
                                    className="bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs px-3 py-1.5 rounded transition"
                                >
                                    ⚡ Run Simulated Safe Update
                                </button>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-xs divide-y divide-slate-800">
                                    <thead>
                                        <tr className="text-slate-500 uppercase font-bold py-3">
                                            <th className="pb-3 pr-2">Plugin Name</th>
                                            <th className="pb-3 px-2">Slug</th>
                                            <th className="pb-3 px-2">Version</th>
                                            <th className="pb-3 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800 text-slate-300">
                                        {vaultPlugins.map((plugin, idx) => (
                                            <tr key={idx} className="hover:bg-slate-800/20">
                                                <td className="py-3 pr-2 font-semibold text-white">{plugin.name}</td>
                                                <td className="py-3 px-2 font-mono text-[10px] text-violet-400">{plugin.slug}</td>
                                                <td className="py-3 px-2 text-slate-400 font-bold">v{plugin.version}</td>
                                                <td className="py-3 text-right">
                                                    <button
                                                        onClick={() => {
                                                            setVaultPlugins(prev => prev.filter((_, i) => i !== idx));
                                                        }}
                                                        className="text-rose-400 hover:text-rose-300 font-bold transition"
                                                    >
                                                        Delete
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500 font-mono">
                            <span>* Pre-signed URLs validate for 15 minutes max</span>
                            <span>Secure Storage Disk: S3</span>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
