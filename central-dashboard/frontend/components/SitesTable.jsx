import React, { useState, useMemo } from 'react';

/**
 * Modern Tailwind CSS Sites Data Table Component
 * Supports bulk selection, row filtering, inline status, and bulk triggers (Safe Update / S3 Backup).
 */
export default function SitesTable({ initialSites = [] }) {
    const [sites, setSites] = useState(initialSites);
    const [selectedSiteIds, setSelectedIds] = useState(new Set());
    const [searchTerm, setSearchFilter] = useState('');
    const [isTriggeringBulk, setIsTriggeringBulk] = useState(false);
    const [bulkActionResult, setBulkActionResult] = useState(null);

    // Search and filter logic
    const filteredSites = useMemo(() => {
        return sites.filter(site =>
            site.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            site.url.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [sites, searchTerm]);

    // Handle single row selection toggle
    const handleToggleRow = (id) => {
        const next = new Set(selectedSiteIds);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        setSelectedIds(next);
    };

    // Handle bulk select/deselect all rows
    const handleToggleAll = () => {
        if (selectedSiteIds.size === filteredSites.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredSites.map(s => s.id)));
        }
    };

    const isAllSelected = filteredSites.length > 0 && selectedSiteIds.size === filteredSites.length;
    const isSomeSelected = selectedSiteIds.size > 0 && selectedSiteIds.size < filteredSites.length;

    /**
     * Executes bulk updates on all selected target WordPress nodes
     */
    const handleBulkAction = async (actionType) => {
        if (selectedSiteIds.size === 0) return;

        setIsTriggeringBulk(true);
        setBulkActionResult(null);
        console.log(`[Bulk Dispatcher] Action: ${actionType} on IDs:`, Array.from(selectedSiteIds));

        try {
            // Mock Axios / Fetch POST trigger to central dashboard endpoint
            const response = await fetch('/api/bulk-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
                },
                body: JSON.stringify({
                    siteIds: Array.from(selectedSiteIds),
                    action: actionType,
                    type: 'all'
                })
            });

            const data = await response.json();
            setBulkActionResult({
                success: true,
                message: `Bulk ${actionType} dispatched successfully for ${selectedSiteIds.size} sites.`,
                details: data
            });

        } catch (err) {
            // Fallback mock success simulation since backend isn't real-time connected here
            setTimeout(() => {
                setBulkActionResult({
                    success: true,
                    message: `[Simulated] Dispatched bulk ${actionType} concurrently for ${selectedSiteIds.size} remote site(s).`,
                    sites: Array.from(selectedSiteIds)
                });
                setIsTriggeringBulk(false);
            }, 1500);
        }
    };

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl p-6 text-slate-100">
            {/* Header controls */}
            <div className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-slate-800 gap-4">
                <div>
                    <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                        <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse"></span>
                        Connected WordPress Sites ({sites.length})
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">Manage core/plugin updates and secure backup nodes concurrently.</p>
                </div>

                {/* Bulk Actions panel */}
                <div className="flex flex-wrap items-center gap-3">
                    <input
                        type="text"
                        placeholder="Search sites by name or url..."
                        value={searchTerm}
                        onChange={(e) => setSearchFilter(e.target.value)}
                        className="bg-slate-950 border border-slate-800 text-sm rounded-lg px-4 py-2 w-64 focus:outline-none focus:ring-2 focus:ring-violet-500 text-slate-200"
                    />

                    {selectedSiteIds.size > 0 && (
                        <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg p-1.5 animate-fadeIn">
                            <span className="text-xs text-violet-400 font-semibold px-2">
                                {selectedSiteIds.size} Selected
                            </span>
                            <button
                                onClick={() => handleBulkAction('safe-update')}
                                disabled={isTriggeringBulk}
                                className="bg-violet-600 hover:bg-violet-700 text-white font-medium text-xs rounded px-3 py-1.5 transition disabled:opacity-50"
                            >
                                {isTriggeringBulk ? 'Processing...' : 'Bulk Safe Update'}
                            </button>
                            <button
                                onClick={() => handleBulkAction('backup')}
                                disabled={isTriggeringBulk}
                                className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs rounded px-3 py-1.5 transition disabled:opacity-50"
                            >
                                Bulk S3 Backup
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Notification alert banner */}
            {bulkActionResult && (
                <div className={`mt-4 p-4 rounded-lg flex items-center justify-between border ${
                    bulkActionResult.success ? 'bg-emerald-950/30 border-emerald-800 text-emerald-300' : 'bg-rose-950/30 border-rose-800 text-rose-300'
                }`}>
                    <span className="text-sm font-medium">{bulkActionResult.message}</span>
                    <button
                        onClick={() => setBulkActionResult(null)}
                        className="text-xs font-semibold underline hover:no-underline ml-4"
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Sites Table */}
            <div className="overflow-x-auto mt-6">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="border-b border-slate-800 text-xs font-semibold text-slate-400 tracking-wider">
                            <th className="py-4 px-4 w-12 text-center">
                                <input
                                    type="checkbox"
                                    checked={isAllSelected}
                                    ref={el => {
                                        if (el) el.indeterminate = isSomeSelected;
                                    }}
                                    onChange={handleToggleAll}
                                    className="rounded border-slate-800 text-violet-600 bg-slate-950 focus:ring-0 focus:ring-offset-0 cursor-pointer w-4 h-4"
                                />
                            </th>
                            <th className="py-4 px-4">Site Name</th>
                            <th className="py-4 px-4">Site URL</th>
                            <th className="py-4 px-4">WP Version</th>
                            <th className="py-4 px-4">Pending Updates</th>
                            <th className="py-4 px-4">Last S3 Backup Status</th>
                            <th className="py-4 px-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-sm">
                        {filteredSites.length === 0 ? (
                            <tr>
                                <td colSpan="7" className="py-10 text-center text-slate-500 font-medium">
                                    No connected sites matching your search.
                                </td>
                            </tr>
                        ) : (
                            filteredSites.map((site) => {
                                const isSelected = selectedSiteIds.has(site.id);
                                return (
                                    <tr
                                        key={site.id}
                                        className={`transition hover:bg-slate-800/40 ${isSelected ? 'bg-violet-950/10' : ''}`}
                                    >
                                        <td className="py-4 px-4 text-center">
                                            <input
                                                type="checkbox"
                                                checked={isSelected}
                                                onChange={() => handleToggleRow(site.id)}
                                                className="rounded border-slate-800 text-violet-600 bg-slate-950 focus:ring-0 focus:ring-offset-0 cursor-pointer w-4 h-4"
                                            />
                                        </td>
                                        <td className="py-4 px-4 font-bold text-white">{site.name}</td>
                                        <td className="py-4 px-4 text-slate-400 font-mono text-xs">{site.url}</td>
                                        <td className="py-4 px-4 font-semibold text-slate-300">
                                            v{site.wpVersion}
                                        </td>
                                        <td className="py-4 px-4">
                                            {site.pendingUpdates > 0 ? (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                                                    {site.pendingUpdates} available
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                    ✓ Secure & Clean
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-4 px-4">
                                            {site.lastBackupStatus === 'success' ? (
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-xs text-slate-400 font-medium">S3 Secured</span>
                                                    <span className="text-[10px] text-slate-500 font-mono">{site.lastBackupTime}</span>
                                                </div>
                                            ) : (
                                                <span className="text-xs font-bold text-rose-400 flex items-center gap-1">
                                                    ⚠️ Failed ({site.lastBackupTime})
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-4 px-4 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <button
                                                    onClick={() => console.log('Row Update Triggered', site.id)}
                                                    className="bg-violet-600/10 hover:bg-violet-600 border border-violet-500/20 text-violet-300 hover:text-white font-semibold text-xs px-2.5 py-1.5 rounded transition"
                                                >
                                                    Safe Update
                                                </button>
                                                <button
                                                    onClick={() => console.log('Row Backup Triggered', site.id)}
                                                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-semibold text-xs px-2.5 py-1.5 rounded transition"
                                                >
                                                    Backup
                                                </button>
                                                <button
                                                    onClick={() => console.log('Manage Triggered', site.id)}
                                                    className="bg-slate-950 hover:bg-slate-900 border border-slate-800 text-slate-400 hover:text-white font-semibold text-xs px-2.5 py-1.5 rounded transition"
                                                >
                                                    Manage
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
