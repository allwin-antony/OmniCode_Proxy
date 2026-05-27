import { exec } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';

export interface HarvesterDetails {
    pid: number;
    csrfToken: string;
    connectPort: number;
}

/**
 * LanguageServerHarvester dynamically discovers the running Antigravity
 * Language Server process, harvests its active CSRF token, and detects
 * the listening HTTPS Connect RPC port using process and socket table lookups.
 */
export class LanguageServerHarvester {
    private static cache: HarvesterDetails | null = null;
    private static lastHarvestTime = 0;
    private static readonly CACHE_TTL = 30000; // Cache details for 30s to avoid expensive lookups

    /**
     * Harvest active Language Server process details, using in-memory cache if fresh.
     */
    public static async getDetails(forceRefresh = false): Promise<HarvesterDetails> {
        const now = Date.now();
        if (!forceRefresh && this.cache && (now - this.lastHarvestTime < this.CACHE_TTL)) {
            return this.cache;
        }

        try {
            const details = await this.performHarvest();
            this.cache = details;
            this.lastHarvestTime = now;
            return details;
        } catch (err: any) {
            // If harvest fails but we have a cached value, fallback to the cache as a last resort
            if (this.cache) {
                console.warn('[Harvester] Harvest lookup failed, falling back to cached server details:', err.message);
                return this.cache;
            }
            throw err;
        }
    }

    private static performHarvest(): Promise<HarvesterDetails> {
        return new Promise((resolve, reject) => {
            // 1. Scan the process table for active Language Server processes, sorted by start time descending
            exec('ps aux --sort=-start_time | grep -i "language_server_linux_x64"', (error, stdout) => {
                if (error) {
                    return reject(new Error(`Failed to query process table: ${error.message}`));
                }

                const lines = stdout.split('\n');
                const processes: Array<{ pid: number; csrfToken: string }> = [];

                for (const line of lines) {
                    // Ignore the grep process itself
                    if (line.includes('grep')) {
                        continue;
                    }

                    // Extract the PID (column 2)
                    const columns = line.trim().split(/\s+/);
                    if (columns.length <= 1) {
                        continue;
                    }

                    const pid = parseInt(columns[1], 10);
                    // Match precisely the main csrf_token argument (ignoring extension_server_csrf_token)
                    const csrfTokenMatch = line.match(/\s--csrf_token\s+([a-f0-9-]+)/i);

                    if (pid && csrfTokenMatch) {
                        processes.push({
                            pid,
                            csrfToken: csrfTokenMatch[1]
                        });
                    }
                }

                if (processes.length === 0) {
                    return reject(new Error('No active Antigravity Language Server process discovered in the process table.'));
                }

                // Since we used --sort=-start_time, the latest spawned process is already first.
                // However, we preserve a robust fallback sorting logic just in case:
                processes.sort((a, b) => {
                    try {
                        const timeA = fs.statSync(`/proc/${a.pid}`).mtimeMs;
                        const timeB = fs.statSync(`/proc/${b.pid}`).mtimeMs;
                        return timeB - timeA;
                    } catch (e) {
                        // Fallback to PID descending if proc is not accessible, but keep ps order if PIDs are equal
                        return b.pid - a.pid;
                    }
                });

                // We will try processes one by one until we find a working one
                const tryProcess = async (index: number) => {
                    if (index >= processes.length) {
                        return reject(new Error('Could not find any listening HTTPS Connect ports on active processes.'));
                    }

                    const proc = processes[index];
                    exec('ss -ltp 2>/dev/null', async (ssError, ssStdout) => {
                        if (ssError) {
                            return reject(new Error(`Failed to query active sockets via ss: ${ssError.message}`));
                        }

                        const ssLines = ssStdout.split('\n');
                        const listeningPorts: number[] = [];

                        for (const line of ssLines) {
                            if (line.includes(`pid=${proc.pid}`)) {
                                const portMatch = line.match(/127\.0\.0\.1:(\d+)/i);
                                if (portMatch) {
                                    const port = parseInt(portMatch[1], 10);
                                    if (!listeningPorts.includes(port)) {
                                        listeningPorts.push(port);
                                    }
                                }
                            }
                        }

                        if (listeningPorts.length === 0) {
                            // Try next process
                            return tryProcess(index + 1);
                        }

                        // Probe all ports of this process in parallel to find the one that responds to HTTPS Connect GetCascadeModelConfigs
                        const probeResults = await Promise.all(
                            listeningPorts.map(async (port) => {
                                const ok = await LanguageServerHarvester.probePort(port, proc.csrfToken);
                                return { port, ok };
                            })
                        );

                        const workingPort = probeResults.find(r => r.ok);
                        if (workingPort) {
                            return resolve({
                                pid: proc.pid,
                                csrfToken: proc.csrfToken,
                                connectPort: workingPort.port
                            });
                        }

                        // If no port works for this process, try the next process
                        tryProcess(index + 1);
                    });
                };

                tryProcess(0);
            });
        });
    }

    private static probePort(port: number, csrfToken: string): Promise<boolean> {
        return new Promise((resolve) => {
            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigs',
                method: 'POST',
                rejectUnauthorized: false,
                timeout: 500, // Short timeout for local probe
                headers: {
                    'Content-Type': 'application/json',
                    'x-codeium-csrf-token': csrfToken,
                    'connect-protocol-version': '1'
                }
            };

            const req = https.request(options, (res) => {
                // We MUST get a 200 OK to verify that both the port and the harvested CSRF token are valid and authenticated!
                if (res.statusCode === 200) {
                    resolve(true);
                } else {
                    resolve(false);
                }
            });

            req.on('error', () => {
                resolve(false);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({}));
            req.end();
        });
    }
}
