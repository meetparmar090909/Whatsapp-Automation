const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const ADODB = require('node-adodb');
// whatsapp-web.js is deferred — required inside initWhatsAppClient() to speed up startup
let Client, LocalAuth, MessageMedia;
const qrcode = require('qrcode');
const { spawn } = require('child_process');

// Increase limit for abort listeners
require('events').EventEmitter.defaultMaxListeners = 50;
if (process.setMaxListeners) process.setMaxListeners(50);
// Set Puppeteer cache path for portable EXE (before importing puppeteer-related modules)
if (app.isPackaged) {
    const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    const puppeteerCachePath = path.join(exeDir, 'puppeteer-cache');
    process.env.PUPPETEER_CACHE_DIR = puppeteerCachePath;
    process.env.PUPPETEER_SKIP_DOWNLOAD = 'false';
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
}

// Disable hardware acceleration to avoid GPU errors
app.disableHardwareAcceleration();

// Additional GPU workaround
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');

// Configure ADODB for packaged environments (use unpacked proxy script)
if (app.isPackaged) {
    // Try multiple possible paths for the adodb.js bridge
    const adodbPaths = [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-adodb', 'lib', 'adodb.js'),
        path.join(process.resourcesPath, 'node_modules', 'node-adodb', 'lib', 'adodb.js'),
        path.join(app.getAppPath(), 'node_modules', 'node-adodb', 'lib', 'adodb.js')
    ];

    for (const adodbPath of adodbPaths) {
        if (fs.existsSync(adodbPath)) {
            ADODB.PATH = adodbPath;
            break;
        }
    }
}

// Global error handling to prevent silent crashes
process.on('uncaughtException', (error) => {
    const errorLog = path.join(app.getPath('userData'), 'crash.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(errorLog, `[${timestamp}] UNCAUGHT EXCEPTION: ${error.stack}\n`);
    if (typeof logToFile === 'function') logToFile(`CRITICAL ERROR: ${error.message}`);

    // Attempt graceful recovery
    if (typeof client !== 'undefined' && client && !isReconnecting) {
        logToFile('Attempting recovery from critical error...');

        // Reset states
        isAuthenticating = false;
        isClientReady = false;

        isReconnecting = true;
        try { client.destroy().catch(() => { }); } catch (e) { }
        client = null;
        setTimeout(() => {
            isReconnecting = false;
            initWhatsAppClient();
        }, 5000);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    const reasonMsg = reason instanceof Error ? reason.message : String(reason);
    logToFile(`Unhandled Rejection at: ${promise} reason: ${reasonMsg}`);
    console.error('Unhandled Rejection:', reason);

    // Recovery: If browser crashed during login, reset state so QR can reappear
    if (!isReconnecting && (reasonMsg.includes('Execution context was destroyed') || reasonMsg.includes('Target closed'))) {
        logToFile('🧪 Browser crash detected in unhandled promise. Resetting connection state...', 'warning');
        isAuthenticating = false;
        isClientReady = false;
    }
});

// Handle graceful shutdown
let isShuttingDown = false;
let isReconnecting = false;
let connectionAttempts = 0;
let maxConnectionAttempts = 5;
let lastHeartbeat = Date.now();

async function gracefulShutdown(reason = 'unknown') {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logToFile(`Starting graceful shutdown (Reason: ${reason})...`);
    console.log(`Starting graceful shutdown (Reason: ${reason})...`);

    // Stop automation
    if (isAutomationRunning) {
        isAutomationRunning = false;
        if (automationAbortController) {
            automationAbortController.abort();
        }
        logToFile('Automation stopped');
    }

    // Destroy WhatsApp client
    if (client) {
        try {
            await client.destroy();
            logToFile('WhatsApp client destroyed');
        } catch (err) {
            logToFile(`Error destroying client: ${err.message}`);
        }
    }

    // Kill all lingering Chrome/cscript processes so nothing stays in Task Manager
    try {
        await forceKillBrowser();
        logToFile('All browser processes terminated');
    } catch (err) {
        logToFile(`Error killing browser processes: ${err.message}`);
    }

    logToFile(`Graceful shutdown completed (${reason})`);
    console.log(`Graceful shutdown completed (${reason})`);
}

function forceKillBrowser() {
    return new Promise((resolve) => {
        logToFile('Executing taskkill for lingering browser and database processes...');
        // We target both chrome and chromium since puppeteer might use either depending on env
        const commands = [
            'taskkill /F /IM chrome.exe /T',
            'taskkill /F /IM chromium.exe /T',
            'taskkill /F /IM cscript.exe /T'
        ];

        let completed = 0;
        let anySuccess = false;

        commands.forEach(cmd => {
            const child = spawn('cmd.exe', ['/c', cmd], { windowsHide: true });

            child.on('exit', (code) => {
                completed++;
                if (code === 0) anySuccess = true;

                if (completed === commands.length) {
                    if (anySuccess) {
                        logToFile('✅ Successfully terminated lingering processes');
                    } else {
                        logToFile('ℹ️ No active processes found to terminate');
                    }
                    resolve();
                }
            });
        });

        // Safety timeout to ensure we don't hang if taskkill behaves unexpectedly
        setTimeout(resolve, 4000);
    });
}

// =============================
// Production Logging & Pathing
// =============================
const logBuffer = [];
const MAX_BUFFER = 50;

function logToFile(message, type = 'info') {
    try {
        const pid = process.pid;
        const userDataPath = app.getPath('userData');
        if (!fs.existsSync(userDataPath)) {
            fs.mkdirSync(userDataPath, { recursive: true });
        }
        const logPath = path.join(userDataPath, 'app.log');
        const now = new Date();
        const timestamp = now.toISOString();
        const displayTime = now.toLocaleTimeString('en-IN', { hour12: false });
        const formattedMessage = `[${timestamp}] [PID:${pid}] ${message}\n`;
        fs.appendFileSync(logPath, formattedMessage);

        const logObj = {
            id: Date.now() + Math.random(),
            time: displayTime,
            message: message,
            type: type
        };

        // Add to buffer
        logBuffer.push(logObj);
        if (logBuffer.length > MAX_BUFFER) logBuffer.shift();

        // Send to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('app-log', logObj);
        }
    } catch (e) {
        // Fallback
    }
    console.log(message);
}

// Global sendLog remains for compatibility but uses logToFile
function sendLog(message, type = 'info') {
    logToFile(message, type);
}

function getProdPath(relativePath) {
    if (app.isPackaged) {
        logToFile(`[PathResolution] Resolving path for: ${relativePath}`);
        // Priority 1: Next to the actual executable (for portable EXE persistence/external DB)
        const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
        const externalPath = path.join(exeDir, relativePath);

        if (fs.existsSync(externalPath)) {
            logToFile(`[PathResolution] Found at EXE location: ${externalPath}`);
            return externalPath;
        }

        // Priority 2: Unpacked folder (for files explicitly unpacked like node-adodb)
        const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', relativePath);
        if (fs.existsSync(unpackedPath)) {
            logToFile(`[PathResolution] Found in Unpacked folder: ${unpackedPath}`);
            return unpackedPath;
        }

        // Priority 3: Bundled resources folder
        const resPath = path.join(process.resourcesPath, relativePath);
        logToFile(`[PathResolution] Using default Resources path: ${resPath}`);
        return resPath;
    }
    return path.join(__dirname, relativePath);
}

// Log initial system info safely
app.whenReady().then(() => {
    logToFile('--- Application Starting ---');
    logToFile(`Packaged: ${app.isPackaged}`);
    logToFile(`User Data Path: ${app.getPath('userData')}`);
    logToFile(`Resources Path: ${process.resourcesPath}`);
    logToFile(`App Dir: ${__dirname}`);
});

app.on('second-instance', (event, commandLine, workingDirectory) => {
    // If someone tries to run a second instance, focus our window.
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// Keep window reference
let mainWindow = null;

// Global variables for WhatsApp client and database
let client = null;
let db = null;
let hasInitializedDb = false;
let dbPathGlobal = null;
let lastDbMtime = 0;
let qrCodeData = null;
let isClientReady = false;
let isAutomationRunning = false;
let automationAbortController = null;
let sessionSentCount = 0;
let isWaiting = false;
let nextSendTime = null;
let isAuthenticating = false;
let qrReconnectTimer = null;
let linkingTimeoutTimer = null;
let browserVisible = false;
let qrWasEverShown = false;    // true only when a QR code was physically displayed
let hasExistingSession = false; // true when restoring a saved session (no QR needed)
// let currentBatchCount = 0; // Removed per user request
// let lastCooldownTime = null; // Removed per user request

// Delay Settings (matching processMessages base delay)
let delaySettings = {
    min: 60,
    max: 120
};

// IPC listener for updating delay settings
ipcMain.on('update-delay-settings', (event, settings) => {
    if (settings && typeof settings.min === 'number' && typeof settings.max === 'number') {
        delaySettings.min = settings.min;
        delaySettings.max = settings.max;
        logToFile(`Delay settings updated: Min=${delaySettings.min}s, Max=${delaySettings.max}s`);
    }
});

// Database state tracking
let hasLoggedNoPending = false;

// =============================
// Utility function for cancellable sleep
// =============================
async function sleepWithCancellation(ms, abortController) {
    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, ms);
        if (abortController) {
            abortController.signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                resolve();
            });
        }
    });
}

// =============================
// Session maintenance to prevent logout
// =============================
function maintainSession() {
    if (!client || !isClientReady) return;

    const presenceInterval = setInterval(async () => {
        if (!client || !isClientReady || isReconnecting) {
            clearInterval(presenceInterval);
            return;
        }

        try {
            await client.sendPresenceAvailable();
            logToFile('🔄 Session presence updated');
        } catch (err) {
            logToFile(`Presence update failed: ${err.message}`);
        }
    }, 60000); // Every 60 seconds (more frequent to keep socket alive)

    client.on('disconnected', () => clearInterval(presenceInterval));
    client.on('logout', () => clearInterval(presenceInterval));
}

let isProcessMessagesActive = false;

// =============================
// Message Processing Function with Cancellation Support
// =============================
async function processMessages() {
    if (!isClientReady || !isAutomationRunning || isProcessMessagesActive) return;
    isProcessMessagesActive = true;

    try {
        while (isAutomationRunning && isClientReady && !automationAbortController?.signal.aborted) {
            // Check if we should abort
            if (automationAbortController?.signal.aborted) {
                logToFile('Automation cancelled by user');
                console.log('Automation cancelled by user');
                break;
            }



            // Fetch pending messages from Access MDB SendQ table (one at a time, ordered by Priority)
            let rows = [];
            try {
                rows = await db.query(`
                    SELECT TOP 1 
                        SendQ.OutId AS Outid, 
                        SendQ.CellNo AS CellNo, 
                        SendQ.MsgStr AS Body_text, 
                        SendQ.Priority AS Priority,
                        SendQAttachment.AttachmentFileName AS AttachmentFile
                    FROM 
                        SendQ 
                    LEFT JOIN 
                        SendQAttachment 
                    ON 
                        SendQ.AttachmentId = SendQAttachment.Id
                    WHERE 
                        SendQ.Status IS NULL 
                        OR SendQ.Status = ''
                    ORDER BY 
                        SendQ.Priority ASC, 
                        SendQ.OutId
                `);
            } catch (dbError) {
                sendLog(`❌ Database query error: ${dbError.message}`, "error");
                await sleepWithCancellation(30000, automationAbortController);
                continue;
            }

            if (rows.length === 0) {
                // Only log "No pending messages" once to prevent clutter
                if (!hasLoggedNoPending) {
                    const dbName = dbPathGlobal ? path.basename(dbPathGlobal) : 'database';
                    hasLoggedNoPending = true;
                }

                // Show countdown in UI even for idle polling
                isWaiting = true;
                const pollInterval = 30000; // 30 second poll (increased to reduce locking)
                nextSendTime = Date.now() + pollInterval;

                // IDLE POLLING: Only hit the disk if mtime has changed
                let hasChanges = false;
                for (let waited = 0; waited < pollInterval; waited += 5000) {
                    await sleepWithCancellation(5000, automationAbortController);
                    if (automationAbortController?.signal.aborted) break;

                    if (dbPathGlobal && fs.existsSync(dbPathGlobal)) {
                        const currentMtime = fs.statSync(dbPathGlobal).mtimeMs;
                        if (currentMtime > lastDbMtime) {
                            hasChanges = true;
                            break;
                        }
                    }
                }

                isWaiting = false;
                nextSendTime = null;

                if (hasChanges) {
                    await initDatabase();
                    hasLoggedNoPending = false;
                    await updateStatsAndSendToRenderer(); // refresh pending count immediately
                }
                continue;
            }

            // Check cancellation before processing
            if (automationAbortController?.signal.aborted) {
                sendLog('Automation cancelled during wait', "system");
                break;
            }

            const row = rows[0];
            hasLoggedNoPending = false; // Reset flag because we found data
            let mobile = row.CellNo;
            const outid = row.Outid;
            const message = row.Body_text || '';
            const attachmentFileName = row.AttachmentFile;
            const rawPriority = row.Priority;
            const priority = (rawPriority !== null && rawPriority !== undefined && rawPriority !== '') ? parseInt(rawPriority) : 5; // Default to 5 (non-urgent) if not set
            const isUrgent = (priority === 0); // ONLY explicit Priority 0 = billing/instant send

            // Skip rows with null/empty CellNo
            if (!mobile || mobile.toString().trim() === '') {
                sendLog(`⚠️ Skipping OutId ${outid}: No phone number (CellNo is null)`, "warning");
                const currentTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-').replace(',', '');
                await db.execute(`UPDATE [SendQ] SET [Status]='INVALID', [DeliveredDateTime]='${currentTime}' WHERE [OutId]=${outid}`);
                continue;
            }

            // Clean number
            mobile = mobile.toString().replace(/[^0-9]/g, '');

            if (mobile.length === 10) {
                mobile = '91' + mobile;
            }

            if (mobile.startsWith('0') && mobile.length === 11) {
                mobile = '91' + mobile.substring(1);
            }

            const chatId = mobile + '@c.us';
            sendLog(`📤 Ready to send to ${mobile}${isUrgent ? ' [⚡ INSTANT]' : ` [Priority ${priority}]`}`);

            // -------------------------------------------------------------
            // PRIORITIZED SAFETY DELAY (BEFORE SENDING)
            // -------------------------------------------------------------
            if (!isUrgent) {
                const delayMs = Math.floor(Math.random() * (delaySettings.max * 1000 - delaySettings.min * 1000 + 1) + delaySettings.min * 1000);
                sendLog(`🕐 Priority ${priority}: Safety delay ${Math.round(delayMs / 1000)}s...`, "system");
                isWaiting = true;
                nextSendTime = Date.now() + delayMs;

                // Loop for delay with periodic checks for new priority 0 messages
                let isPreempted = false;
                for (let waited = 0; waited < delayMs; waited += 5000) {
                    await sleepWithCancellation(5000, automationAbortController);
                    if (automationAbortController?.signal.aborted) break;

                    // INTERRUPT FOR PRIORITY 0: Check if an urgent message just arrived
                    try {
                        const p0Check = await db.query(`SELECT TOP 1 OutId FROM [SendQ] WHERE ([Status] IS NULL OR [Status] = '') AND [Priority] = 0`);
                        if (p0Check && p0Check.length > 0) {
                            sendLog(`⚡ Priority 0 detected! Jumping to urgent queue...`, 'system');
                            isPreempted = true;
                            break;
                        }
                    } catch (e) {
                         // DB busy, just keep waiting
                    }
                }

                isWaiting = false;
                nextSendTime = null;

                if (isPreempted) continue; // Go back to top of loop and fetch the priority 0 message
            }

            try {
                // Check if number is registered (with retry for WidFactory not ready)
                let isRegistered = false;
                let regCheckRetries = 0;
                const maxRegCheckRetries = 3;
                while (regCheckRetries < maxRegCheckRetries) {
                    try {
                        isRegistered = await client.isRegisteredUser(chatId);
                        break; // Success, exit retry loop
                    } catch (regErr) {
                        regCheckRetries++;
                        if (regErr.message.includes('WidFactory') || regErr.message.includes('undefined')) {
                            sendLog(`⚠️ WhatsApp internals not ready (attempt ${regCheckRetries}/${maxRegCheckRetries}), waiting 5s...`, "warning");
                            await sleepWithCancellation(5000, automationAbortController);
                            if (automationAbortController?.signal.aborted) break;
                        } else {
                            throw regErr; // Re-throw non-WidFactory errors
                        }
                    }
                }
                if (automationAbortController?.signal.aborted) break;
                if (regCheckRetries >= maxRegCheckRetries) {
                    sendLog(`⚠️ Could not verify ${mobile} after ${maxRegCheckRetries} retries, skipping...`, "warning");
                    await sleepWithCancellation(10000, automationAbortController);
                    continue;
                }

                if (!isRegistered) {
                    sendLog(`❌ Not WhatsApp number: ${mobile}`, "error");
                    const currentTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-').replace(',', '');
                    await db.execute(`UPDATE [SendQ] SET [Status]='INVALID', [DeliveredDateTime]='${currentTime}' WHERE [OutId]=${outid}`);
                    continue;
                }

                // ===== SEND ATTACHMENT + MESSAGE (combined as caption if both exist) =====
                const hasAttachment = attachmentFileName && attachmentFileName.trim() !== '' && attachmentFileName !== null;

                if (hasAttachment) {
                    let filePath;

                    if (path.isAbsolute(attachmentFileName)) {
                        filePath = attachmentFileName;
                    } else {
                        filePath = path.join(getProdPath('attachments'), attachmentFileName);
                        if (!fs.existsSync(filePath)) {
                            const altPath = path.join(getProdPath('.'), attachmentFileName);
                            if (fs.existsSync(altPath)) {
                                filePath = altPath;
                            } else {
                                sendLog(`❌ Attachment file missing for ID: ${outid}, filename: ${attachmentFileName}`, "warning");
                            }
                        }
                    }

                    if (fs.existsSync(filePath)) {
                        const media = MessageMedia.fromFilePath(filePath);
                        const isDocument = media.mimetype && !media.mimetype.startsWith('image/') && !media.mimetype.startsWith('video/') && !media.mimetype.startsWith('audio/');
                        const sendOptions = isDocument ? { sendMediaAsDocument: true } : {};
                        if (message && message.trim() !== '') {
                            sendLog(`📎 Attaching file with caption: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
                            await client.sendMessage(chatId, media, { ...sendOptions, caption: message });
                        } else {
                            sendLog(`📎 Attaching file: ${attachmentFileName}`);
                            await client.sendMessage(chatId, media, sendOptions);
                        }
                    }
                }

                // Check cancellation before sending message
                if (automationAbortController?.signal.aborted) {
                    sendLog('Automation cancelled before sending message', "system");
                    break;
                }

                // ===== SEND TEXT MESSAGE (only if no attachment) =====
                if (!hasAttachment) {
                    if (message && message.trim() !== '') {
                        sendLog(`💬 Sending: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
                        await client.sendMessage(chatId, message);
                    } else {
                        await client.sendMessage(chatId, ' ');
                    }
                }

                // ===== UPDATE DATABASE STATUS =====
                try {
                    const currentTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-').replace(',', '');
                    await db.execute(`UPDATE [SendQ] SET [Status]='s', [DeliveredDateTime]='${currentTime}' WHERE [OutId]=${outid}`);
                    sendLog(`✅ Status updated for ID ${outid}`, "success");
                } catch (updateErr) {
                    sendLog(`❌ DB write failed for ID ${outid}: ${updateErr.message}, retrying...`, "error");
                    let writeSuccess = false;
                    for (let retry = 1; retry <= 3; retry++) {
                        try {
                            await sleepWithCancellation(2000 * retry, automationAbortController);
                            if (automationAbortController?.signal.aborted) break;
                            const retryTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-').replace(',', '');
                            await db.execute(`UPDATE [SendQ] SET [Status]='s', [DeliveredDateTime]='${retryTime}' WHERE [OutId]=${outid}`);
                            sendLog(`✅ DB write retry ${retry} succeeded for ID ${outid}`, "success");
                            writeSuccess = true;
                            break;
                        } catch (retryErr) {
                            sendLog(`⚠️ DB write retry ${retry}/3 failed: ${retryErr.message}`, "warning");
                        }
                    }
                    if (!writeSuccess) {
                        sendLog(`⚠️ All DB write retries failed for ID ${outid}. Skipping...`, "warning");
                        await sleepWithCancellation(5000, automationAbortController);
                        continue;
                    }
                }

                // Update UI immediately
                cachedPendingCount = Math.max(0, cachedPendingCount - 1);
                cachedSentCount++;
                sendLog(`✅ Sent to ${mobile}`, "success");
                sessionSentCount++;
                lastHeartbeat = Date.now(); // Update heartbeat on success

                // Check remaining
                const checkRemaining = await db.query(`SELECT COUNT(*) as totalCount FROM [SendQ] WHERE [Status] IS NULL OR [Status] = ''`);
                const remainingCount = (checkRemaining && checkRemaining.length > 0) ? checkRemaining[0].totalCount : 0;
                sendLog(`📊 Remaining pending: ${remainingCount}`, "system");
                if (remainingCount === 0) {
                    sendLog(`✅ All messages sent!`, "success");
                }

            } catch (err) {
                if (isShuttingDown || automationAbortController?.signal.aborted) {
                    logToFile(`Message sending interrupted by shutdown/stop: ${err.message}`, "system");
                } else {
                    console.error(`❌ Error sending to ${mobile}:`, err.message);
                    logToFile(`Message sending error: ${err.message}`);

                    // If protocol error / target closed, browser probably crashed
                    if (err.message.includes('Target closed') || err.message.includes('Protocol error')) {
                        logToFile('⚠️ Browser crash detected during send. Triggering reconnect...', 'warning');
                        if (!isReconnecting) {
                            isReconnecting = true;
                            isClientReady = false;
                            isAutomationRunning = false;
                            try { client.destroy().catch(() => { }); } catch (e) { }
                            client = null;
                            setTimeout(() => {
                                isReconnecting = false;
                                initWhatsAppClient();
                            }, 5000);
                        }
                    }
                    
                    // Mark as failed ('f') in DB so we can retry later manually
                    try {
                        const failTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-').replace(',', '');
                        await db.execute(`UPDATE [SendQ] SET [Status]='f', [DeliveredDateTime]='${failTime}' WHERE [OutId]=${outid}`);
                        sendLog(`❌ Marked ID ${outid} as Failed`, "error");
                    } catch (dbErr) {
                        logToFile(`Critical: Failed to mark Outid ${outid} as 'f' in DB: ${dbErr.message}`);
                    }
                    await sleepWithCancellation(10000, automationAbortController);
                }
            }
        }

    } catch (err) {
        sendLog(`🚨 Process messages error: ${err.message}`, "error");
    } finally {
        isProcessMessagesActive = false;
        isAutomationRunning = false;
        sendLog('🏁 Automation process finished', "system");

        // Send status to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('automation-status-changed', { isRunning: false });
        }
    }
}

// =============================
// Database initialization
// =============================
let writeLock = false; // Simple mutex for writes

// Initialize MS Access database integration with verification
async function initDatabase() {
    const isFirstTime = !hasInitializedDb;
    const dbPath = getProdPath('COPIM.accdb');
    dbPathGlobal = dbPath;


    // Update mtime to track external changes
    if (fs.existsSync(dbPath)) {
        lastDbMtime = fs.statSync(dbPath).mtimeMs;
    }

    if (isFirstTime) logToFile(`[Database] Attempting to connect. File: ${dbPath}`);

    // Check if MDB file exists
    if (!fs.existsSync(dbPath)) {
        logToFile(`[Database] 🚨 ERROR: MDB file NOT found at: ${dbPath}`);
        return;
    }

    if (isFirstTime) logToFile(`[Database] 📁 SUCCESS: Loading database from: ${dbPath}`);

    // Architecture detection — try 32-bit cscript first (SysWOW64) since Access drivers are typically 32-bit
    const sysroot = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows';
    const cscript32 = path.join(sysroot, 'SysWOW64', 'cscript.exe'); // 32-bit
    const cscript64 = path.join(sysroot, 'System32', 'cscript.exe'); // 64-bit
    const adodbVbs = getProdPath(path.join('node_modules', 'node-adodb', 'lib', 'adodb.js'));

    // Determine which cscript to use — prefer 32-bit if it exists (Access drivers are usually 32-bit)
    const cscriptPaths = [];
    if (isFirstTime) {
        if (fs.existsSync(cscript32)) {
            cscriptPaths.push(cscript32);
            logToFile(`[Database] Found 32-bit cscript: ${cscript32}`);
        }
        if (fs.existsSync(cscript64)) {
            cscriptPaths.push(cscript64);
            logToFile(`[Database] Found 64-bit cscript: ${cscript64}`);
        }
        logToFile(`[Database] adodb.js path: ${adodbVbs} (exists: ${fs.existsSync(adodbVbs)})`);
    } else {
        if (fs.existsSync(cscript32)) cscriptPaths.push(cscript32);
        if (fs.existsSync(cscript64)) cscriptPaths.push(cscript64);
    }

    // Create a robust db wrapper
    // We use mdb-reader for 100% reliable READS (pure JS)
    // We use a custom cscript spawn for WRITES (try 32-bit first, then 64-bit)
    try {
        const MDBReaderModule = await import('mdb-reader');
        const MDBReader = MDBReaderModule.default || MDBReaderModule;

        db = {
            _dbPath: dbPath,
            _MDBReader: MDBReader,
            _cscriptPaths: cscriptPaths,
            _adodbVbs: adodbVbs,

            // READ: Pure JS mdb-reader using a Shadow Copy to prevent ANY locking
            query: async function (sql) {
                let tempShadowPath = null;
                try {
                    // Create a shadow copy in the temp directory
                    const tempDir = app.getPath('temp');
                    tempShadowPath = path.join(tempDir, `wa_db_shadow_${process.pid}_${Date.now()}.accdb`);

                    // Copy the database file to temp to ensure NO handle is kept on the original
                    // This is the only way to 100% guarantee no 'ldb' lock issues for reads
                    try {
                        fs.copyFileSync(this._dbPath, tempShadowPath);
                    } catch (copyErr) {
                        // If copy fails (e.g. file busy), try reading original directly as fallback
                        const buffer = fs.readFileSync(this._dbPath);
                        const reader = new this._MDBReader(buffer);
                        return this._processQueryResult(reader, sql);
                    }

                    const buffer = fs.readFileSync(tempShadowPath);
                    const reader = new this._MDBReader(buffer);

                    // Cleanup temp file immediately
                    try { fs.unlinkSync(tempShadowPath); tempShadowPath = null; } catch (e) { }

                    return this._processQueryResult(reader, sql);
                } catch (e) {
                    if (tempShadowPath && fs.existsSync(tempShadowPath)) {
                        try { fs.unlinkSync(tempShadowPath); } catch (ex) { }
                    }
                    logToFile(`[Database-Read] Error: ${e.message}`, "error");
                    return [];
                }
            },

            // Internal helper to process the MDB result
            _processQueryResult: function (reader, sql) {
                try {
                    // Normalize SQL for parsing
                    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
                    // ... (rest of the matching logic remains the same)
                    const match = normalizedSql.match(/SELECT\s+(?:TOP\s+(\d+)\s+)?(.*?)\s+FROM\s+([\w\[\]\.]+)(?:\s+LEFT\s+JOIN\s+([\w\[\]\.]+)\s+ON\s+(.*?))?(?:\s+WHERE\s+(.*?))?(?:\s+ORDER\s+BY\s+(.*?))?$/i);
                    // ... [rest of the existing logic from lines 668 to 789] ... (I will include the actual logic in the replacement)
                    if (!match) return [];
                    const topN = match[1] ? parseInt(match[1]) : null;
                    const selectCols = match[2].trim();
                    const tableName = match[3].replace(/[\[\]]/g, '');
                    const joinTable = match[4] ? match[4].replace(/[\[\]]/g, '') : null;
                    const whereClause = match[6] || null;
                    const orderClause = match[7] || null;

                    const table = reader.getTable(tableName);
                    if (!table) return [];
                    let rows = table.getData();

                    if (joinTable) {
                        try {
                            const joinTbl = reader.getTable(joinTable);
                            if (joinTbl) {
                                const joinRows = joinTbl.getData();
                                const onMatch = match[5].match(/([\w\.]+)\s*=\s*([\w\.]+)/i);
                                if (onMatch) {
                                    const leftCol = onMatch[1].replace(/.*?\./, '').replace(/[\[\]]/g, '');
                                    const rightCol = onMatch[2].replace(/.*?\./, '').replace(/[\[\]]/g, '');
                                    rows = rows.map(row => {
                                        const joinRow = joinRows.find(jr => jr[rightCol] == row[leftCol]) || {};
                                        return { ...row, ...joinRow };
                                    });
                                }
                            }
                        } catch (e) { }
                    }

                    if (whereClause) {
                        const lowWhere = whereClause.toLowerCase().replace(/trim\s*\(/gi, '').replace(/ucase\s*\(/gi, '').replace(/\)/g, '');
                        const andParts = lowWhere.split(/\band\b/i);
                        for (const part of andParts) {
                            const p = part.trim();
                            if (p.includes("status is null") || (p.includes("status") && p.includes("= ''"))) {
                                rows = rows.filter(r => !r.Status || r.Status === null || r.Status.toString().trim() === '');
                            } else if (p.includes("status") && (p.includes("= 's'") || p.includes("='s'"))) {
                                rows = rows.filter(r => r.Status && r.Status.toString().trim().toLowerCase() === 's');
                            } else if (p.includes("priority")) {
                                const prioMatch = p.match(/priority[^\d]*=\s*(\d+)/i);
                                if (prioMatch) {
                                    const prioVal = parseInt(prioMatch[1]);
                                    rows = rows.filter(r => {
                                        const rowPrio = (r.Priority !== null && r.Priority !== undefined) ? parseInt(r.Priority) : 5;
                                        return rowPrio === prioVal;
                                    });
                                }
                            }
                        }
                    }

                    if (orderClause) {
                        const orderParts = orderClause.split(',').map(p => p.trim());
                        rows.sort((a, b) => {
                            for (const part of orderParts) {
                                const match = part.match(/([\w\.]+)(?:\s+(ASC|DESC))?/i);
                                if (!match) continue;
                                const colName = match[1].replace(/.*?\./, '').replace(/[\[\]]/g, '');
                                const dir = match[2] ? match[2].toUpperCase() : 'ASC';
                                const aVal = a[colName];
                                const bVal = b[colName];
                                if (aVal == bVal) continue;
                                const cmp = aVal < bVal ? -1 : 1;
                                return dir === 'DESC' ? -cmp : cmp;
                            }
                            return 0;
                        });
                    }

                    if (topN) rows = rows.slice(0, topN);
                    if (selectCols.match(/COUNT\(\*\)/i)) return [{ totalCount: rows.length }];

                    if (selectCols && selectCols !== '*') {
                        const colMappings = selectCols.split(',').map(c => {
                            const trimmed = c.trim();
                            const aliasMatch = trimmed.match(/(?:[\w\[\]\.]+\.)?(\w[\w\[\]\.]*)\s+AS\s+(\w[\w\[\]\.]*)/i);
                            if (aliasMatch) return { from: aliasMatch[1].replace(/[\[\]]/g, ''), to: aliasMatch[2].replace(/[\[\]]/g, '') };
                            const dotMatch = trimmed.match(/(?:[\w\[\]\.]+\.)?(\w[\w\[\]\.]*)/);
                            return { from: dotMatch[1].replace(/[\[\]]/g, ''), to: dotMatch[1].replace(/[\[\]]/g, '') };
                        });
                        rows = rows.map(row => {
                            const mapped = {};
                            for (const { from, to } of colMappings) {
                                mapped[to] = row[from] !== undefined ? row[from] : null;
                            }
                            return mapped;
                        });
                    }
                    return rows;
                } catch (e) {
                    return [];
                }
            },

            // WRITE: Try each cscript (32-bit first, then 64-bit) × each provider
            execute: async function (sql) {
                const providers = [
                    `Provider=Microsoft.ACE.OLEDB.16.0;Data Source="${this._dbPath}";Mode=Share Deny None;Jet OLEDB:Database Locking Mode=1;Persist Security Info=False;`,
                    `Provider=Microsoft.ACE.OLEDB.12.0;Data Source="${this._dbPath}";Mode=Share Deny None;Jet OLEDB:Database Locking Mode=1;Persist Security Info=False;`
                ];

                let lastErr = null;
                for (const provider of providers) {
                    for (const cscriptPath of this._cscriptPaths) {
                        try {
                            return await this._rawExecute(cscriptPath, provider, sql);
                        } catch (e) {
                            lastErr = e;
                            // Try all cscript/provider combos — don't bail early on Unknown Error
                            // or other transient failures; only stop if clearly a real DB error.
                            const msg = e.message.toLowerCase();
                            const isFatalDbError = !msg.includes('provider cannot be found') &&
                                !msg.includes('unknown error') &&
                                !msg.includes('timed out') &&
                                !msg.includes('spawn error');
                            if (isFatalDbError) {
                                throw e;
                            }
                            continue;
                        }
                    }
                }
                throw lastErr || new Error("Appropriate Access providers not found on this system.");
            },

            _rawExecute: function (cscriptPath, connectionString, sql) {
                return new Promise((resolve, reject) => {
                    const params = JSON.stringify({ connection: connectionString, sql: sql });

                    // Use a very specific spawn to avoid Bit-mismatch or Path-space issues
                    const child = spawn(cscriptPath, [this._adodbVbs, '//E:JScript', '//Nologo', '//U', '//B', 'execute'], {
                        windowsHide: true,
                        shell: false
                    });

                    let stdout = '';
                    let stderr = '';
                    let settled = false;

                    const settle = (fn, val) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        fn(val);
                    };

                    // 15-second timeout for cscript execution
                    const timeout = setTimeout(() => {
                        logToFile('⚠️ Cscript execution timed out, killing process...', 'warning');
                        try { child.kill(); } catch (e) { }
                        settle(reject, new Error('Cscript execution timed out'));
                    }, 15000);

                    child.stdout.on('data', (data) => stdout += data.toString('utf16le'));
                    child.stderr.on('data', (data) => stderr += data.toString('utf16le'));

                    child.on('error', (err) => {
                        settle(reject, new Error(`Spawn Error: ${err.message}`));
                    });

                    // Suppress EPIPE/write errors on stdin if child dies early
                    child.stdin.on('error', () => {});

                    child.on('close', (code) => {
                        if (code !== 0 || (stderr && stderr.trim().length > 0)) {
                            let errText = stderr || stdout || 'Unknown Error';
                            // Try to parse JSON error from adodb.js: {"code":N,"message":"..."}
                            try {
                                const errObj = JSON.parse(errText);
                                if (errObj.message) errText = errObj.message;
                            } catch (e) { }
                            settle(reject, new Error(`VBScript Error (Code ${code}): ${errText}`));
                        } else {
                            settle(resolve);
                        }
                    });

                    // Send params to stdin with UTF-16LE BOM so WScript.StdIn.ReadAll()
                    // correctly decodes the data in Unicode mode (//U flag).
                    // Without the BOM, ReadAll() may return empty/garbled text,
                    // causing JSON.parse to throw an uncaught SyntaxError → exit code 1, no stderr.
                    const bom = Buffer.from([0xFF, 0xFE]);
                    const paramsBuffer = Buffer.from(params, 'utf16le');
                    child.stdin.write(Buffer.concat([bom, paramsBuffer]));
                    child.stdin.end();
                });
            }
        };

        if (isFirstTime) logToFile(`[Database] ✅ SUCCESS: Initialized modern hybrid engine (JS-Read/VBS-Write)`);
        hasInitializedDb = true;
    } catch (err) {
        logToFile(`[Database] ❌ CRITICAL: Failed to initialize hybrid engine: ${err.message}`);
    }
}


// Get auth path for WhatsApp session
function getAuthPath() {
    // For packaged EXE, store auth next to the executable for portability
    if (app.isPackaged) {
        const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
        return path.join(exeDir, 'wwebjs_auth');
    }
    // For development, use userData
    return path.join(app.getPath('userData'), 'wwebjs_auth');
}

// Get Chrome executable path for Puppeteer
function getChromePath() {
    if (app.isPackaged) {
        // Priority 1: Check common Windows installation paths FIRST
        // System browsers are guaranteed to have all their DLL dependencies installed
        const commonPaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ];

        for (const chromePath of commonPaths) {
            if (fs.existsSync(chromePath)) {
                logToFile(`Found System Browser: ${chromePath}`);
                return chromePath;
            }
        }

        // Priority 2: Fallback to bundled portable Chrome in puppeteer-cache
        // This might fail on some PCs with "Code 1" if MSVC C++ Redistributables are missing
        const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
        const puppeteerCachePath = path.join(exeDir, 'puppeteer-cache');

        try {
            if (fs.existsSync(puppeteerCachePath)) {
                const chromePaths = findChromeInFolder(puppeteerCachePath);
                if (chromePaths.length > 0) {
                    logToFile(`Found Chrome in puppeteer-cache: ${chromePaths[0]}`);
                    return chromePaths[0];
                }
            }
        } catch (err) {
            logToFile(`Error finding Chrome in cache: ${err.message}`);
        }

        logToFile('Chrome not found in any common locations.');
        return undefined;
    }
    // In development, let Puppeteer use its own Chrome
    return undefined;
}

// Helper to find chrome.exe in a folder recursively
function findChromeInFolder(folderPath) {
    const results = [];
    try {
        const items = fs.readdirSync(folderPath);
        for (const item of items) {
            const fullPath = path.join(folderPath, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                results.push(...findChromeInFolder(fullPath));
            } else if (item === 'chrome.exe' || item === 'chromium.exe') {
                results.push(fullPath);
            }
        }
    } catch (err) {
        // Ignore errors
    }
    return results;
}

// Initialize WhatsApp client
let isInitializingClient = false;

async function initWhatsAppClient() {
    if (isInitializingClient) {
        logToFile('ℹ️ System already initializing client, ignoring duplicate request.');
        return;
    }
    isInitializingClient = true;

    // Deferred require — keeps startup fast; Node caches after first load
    if (!Client) {
        ({ Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'));
    }

    const authPath = getAuthPath();
    const chromePath = getChromePath();

    // 1. CLEANUP PREVIOUS LOCKS (fixes "Browser already running" error)
    logToFile(`[Startup] Cleaning up browser session at: ${authPath}`);
    try {
        const sessionPath = path.join(authPath, 'session');
        const lockFiles = [
            path.join(sessionPath, 'SingletonLock'),
            path.join(sessionPath, 'SingletonCookie'),
            path.join(sessionPath, 'SingletonSocket'),
            path.join(sessionPath, 'Default', 'LOCK')
        ];

        // Use for...of so await actually works (forEach does NOT await)
        for (const f of lockFiles) {
            if (fs.existsSync(f)) {
                try {
                    fs.unlinkSync(f);
                    logToFile(`[Cleanup] Removed lingering lock: ${path.basename(f)}`);
                } catch (e) {
                    logToFile(`[Cleanup] Locked file detected: ${path.basename(f)}. Forcing taskkill...`, 'warning');
                    await forceKillBrowser();
                    try { fs.unlinkSync(f); } catch (e2) { } // Try one last time after kill
                }
            }
        }

        // 2. CLEAR BLOATED BROWSER CACHES (Dramatically speeds up existing session loading)
        const cacheDirs = [
            path.join(sessionPath, 'Default', 'Cache'),
            path.join(sessionPath, 'Default', 'Code Cache'),
            path.join(sessionPath, 'Default', 'Service Worker', 'CacheStorage'),
            path.join(sessionPath, 'Default', 'Service Worker', 'ScriptCache')
        ];
        cacheDirs.forEach(dir => {
            if (fs.existsSync(dir)) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                    logToFile(`[Cleanup] Cleared bloated browser cache: ${path.basename(dir)}`);
                } catch (e) { }
            }
        });

    } catch (err) {
        logToFile(`[Cleanup] Error during lock removal: ${err.message}`);
    }

    const sessionPath = path.join(authPath, 'session');
    hasExistingSession = fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
    if (hasExistingSession) {
        logToFile('📡 Existing session detected. Attempting to restore connection...', 'info');
    }

    isAuthenticating = false;
    isClientReady = false;
    qrCodeData = null;
    qrWasEverShown = false;
    if (qrReconnectTimer) {
        clearTimeout(qrReconnectTimer);
        qrReconnectTimer = null;
    }
    logToFile('🚀 RESTARTING ENGINE: initWhatsAppClient() called');
    logToFile(`Initializing WhatsApp Client... Auth path: ${authPath}`);
    if (chromePath) {
        logToFile(`Chrome path: ${chromePath}`);
    }

    const puppeteerOptions = {
        headless: !browserVisible,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1024,768',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--safebrowsing-disable-auto-update'
        ]
    };

    // Only set executablePath if we have a custom Chrome path
    if (chromePath) {
        puppeteerOptions.executablePath = chromePath;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: authPath
        }),
        // No pinned webVersion — let whatsapp-web.js fetch the latest automatically
        // (pinning a stale version causes slow load → phone QR session expires → "Couldn't log in")
        restartOnAuthFail: true,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 60000, // 1 minute
        authTimeoutMs: 600000, // 10 minutes (increased for slow syncs)
        qrMaxRetries: 0,
        puppeteer: puppeteerOptions
    });

    // Handle initialization errors
    client.on('error', (error) => {
        logToFile(`WhatsApp client error: ${error.message}`);
        // Optionally send error to renderer
        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-error', { message: error.message });
        }
    });

    // =============================
    // QR Code Handler
    // =============================
    client.on('qr', async (qr) => {
        // Only block QR if the client is ALREADY fully ready.
        // If it's just "authenticating" but generates a new QR, it means the last attempt failed.
        if (isClientReady) {
            logToFile('🚫 Ignoring late QR code (Client already fully connected)');
            return;
        }

        qrWasEverShown = true; // A QR was physically displayed — used to detect fresh vs restore

        if (isAuthenticating) {
            logToFile('⚠️ Client was linking, but generated a new QR. Resetting link state...');
            isAuthenticating = false;
        }

        logToFile('📱 QR Code generated - Scan once time');

        if (qrReconnectTimer) clearTimeout(qrReconnectTimer);
        // If we are currently "linking" or "ready", don't set the QR timeout
        if (!isClientReady && !isAuthenticating) {
            qrReconnectTimer = setTimeout(async () => {
                logToFile('⏳ QR Scan Timeout (2 mins). Hard-resetting to refresh scanner...', 'warning');

                try {
                    if (client) {
                        await client.destroy().catch(() => { });
                        client = null;
                    }
                    await forceKillBrowser();
                } catch (e) { }

                isAuthenticating = false;
                isClientReady = false;
                qrCodeData = null;

                initWhatsAppClient();
            }, 120000);
        }

        // Always clear linking timeout if we are back to QR stage
        if (linkingTimeoutTimer) {
            clearTimeout(linkingTimeoutTimer);
            linkingTimeoutTimer = null;
        }
        try {
            qrCodeData = await qrcode.toDataURL(qr);
            if (mainWindow) {
                mainWindow.webContents.send('qr-code-updated', qrCodeData);
            }
        } catch (err) {
            logToFile(`QR Code generation error: ${err.message}`);
        }
    });

    // =============================
    // Authentication Progress Handlers
    // =============================
    client.on('authenticated', () => {
        isAuthenticating = true;

        // QR is scanned, clear QR timer
        if (qrReconnectTimer) {
            clearTimeout(qrReconnectTimer);
            qrReconnectTimer = null;
        }

        // Start safety timeout for "Linking" phase. If it takes > 5 mins to reach "ready", reset.
        if (linkingTimeoutTimer) clearTimeout(linkingTimeoutTimer);
        linkingTimeoutTimer = setTimeout(async () => {
            if (!isClientReady) {
                logToFile('⏳ Linking Timeout (5 mins). Sync is taking too long, forcing restart...', 'error');
                try {
                    if (client) await client.destroy().catch(() => { });
                    client = null;
                    await forceKillBrowser();
                } catch (e) { }
                isAuthenticating = false;
                initWhatsAppClient();
            }
        }, 1800000); // 30 minutes (increased from 5 — essential for heavy accounts/slow sync)

        if (qrWasEverShown) {
            logToFile('✅ QR SCANNED! Device linking in progress — please wait...', 'success');
        }
        // Send fast update to hide QR earlier
        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-status-updated', {
                isClientReady: false,
                isAuthenticating: true,
                qrCode: null
            });
            // Force a stats refresh right now
            updateStatsAndSendToRenderer();
        }
    });

    client.on('loading_screen', (percent, message) => {
        const wasAlreadyAuthenticating = isAuthenticating;
        isAuthenticating = true; // Block QRs as soon as loading starts
        if (qrReconnectTimer) {
            clearTimeout(qrReconnectTimer);
            qrReconnectTimer = null;
        }
        if (!wasAlreadyAuthenticating) {
            // Show "Linking..." in UI immediately — this is the fastest possible feedback
            if (mainWindow) {
                mainWindow.webContents.send('whatsapp-status-updated', {
                    isClientReady: false,
                    isAuthenticating: true,
                    qrCode: null
                });
            }
            if (qrWasEverShown) {
                logToFile('✅ QR SCANNED! Syncing data, please wait...', 'success');
            } else if (hasExistingSession) {
                logToFile('📡 Restoring saved session...', 'info');
            }
        }
        logToFile(`⏳ Loading WhatsApp: ${percent}% - ${message}`);
        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-loading', { percent, message });
        }
    });

    // =============================
    // Client Ready Handler
    // =============================
    client.on('ready', () => {
        // --- Update state and notify UI FIRST for instant feedback ---
        isClientReady = true;
        isAuthenticating = false;
        isReconnecting = false;
        qrCodeData = null;
        lastHeartbeat = Date.now();
        connectionAttempts = 0;

        const userName = client.info ? (client.info.pushname || client.info.wid.user) : 'WhatsApp User';
        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-status-updated', {
                isClientReady,
                qrCode: null,
                userName: userName
            });
        }

        logToFile(`🟢 CONNECTED! WhatsApp is ready — ${userName}`, 'success');

        // Clear all connection-related timers
        if (qrReconnectTimer) {
            clearTimeout(qrReconnectTimer);
            qrReconnectTimer = null;
        }
        if (linkingTimeoutTimer) {
            clearTimeout(linkingTimeoutTimer);
            linkingTimeoutTimer = null;
        }

        logToFile('🔒 SESSION SECURED: This device is now the exclusive controller.', 'system');

        // Prevent session conflicts with other devices
        try {
            client.sendPresenceAvailable().catch(err => {
                logToFile(`Presence update error: ${err.message}`);
            });
            maintainSession();
        } catch (err) {
            logToFile(`Session maintenance error: ${err.message}`);
        }

        // Refresh stats immediately
        updateStatsAndSendToRenderer();

        // Auto-start automation when client is ready (with warm-up delay)
        if (!isAutomationRunning) {
            logToFile('🚀 Auto-starting automation in 10 seconds (waiting for WhatsApp internals)...');
            isAutomationRunning = true;
            automationAbortController = new AbortController();

            if (mainWindow) {
                mainWindow.webContents.send('automation-status-changed', { isRunning: true });
            }

            // Wait 10 seconds for WhatsApp internal modules (WidFactory etc.) to fully initialize
            setTimeout(() => {
                if (isAutomationRunning && isClientReady) {
                    logToFile('🚀 Warm-up complete. Starting message processing...');
                    processMessages();
                }
            }, 10000);
        }
    });

    // =============================
    // Client Disconnected Handler
    // =============================
    client.on('disconnected', (reason) => {
        logToFile(`⚠️ WhatsApp client disconnected: ${reason}`, "warning");

        // Reset state
        isClientReady = false;
        isAuthenticating = false;
        qrCodeData = null;

        // Stop automation if running
        if (isAutomationRunning) {
            isAutomationRunning = false;
            if (automationAbortController) {
                automationAbortController.abort();
            }
            console.log('🏁 Automation stopped due to disconnection');
            logToFile('Automation stopped due to disconnection');

            // Send status to renderer
            if (mainWindow) {
                mainWindow.webContents.send('automation-status-changed', { isRunning: false });
            }
        }

        // Send status to renderer process
        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-status-updated', { isClientReady: false, qrCode: null });
        }

        // Destroy, clear auth, and recreate client after a delay
        setTimeout(async () => {
            logToFile('🔄 Recreating WhatsApp client...', "system");
            logToFile('Recreating WhatsApp client after disconnection');
            try {
                await client.destroy();
            } catch (err) {
                logToFile(`Client destroy error: ${err.message}`);
            }

            // Clear auth folder to force new QR code
            const authPath = getAuthPath();
            logToFile(`Clearing auth folder: ${authPath}`);
            try {
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    logToFile('Cleared auth folder after disconnection');
                } else {
                    logToFile('Auth folder does not exist, nothing to clear');
                }
            } catch (err) {
                logToFile(`Failed to clear auth folder: ${err.message}`);
            }

            client = null;
            initWhatsAppClient();
        }, 3000);
    });

    // =============================
    // Auth Failure Handler
    // =============================
    client.on('auth_failure', (msg) => {
        logToFile(`❌ Authentication failed: ${msg}`, "error");
        isClientReady = false;
        isAuthenticating = false;
        qrCodeData = null;

        // Send status to renderer process
        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-status-updated', { isClientReady: false, qrCode: null });
        }

        // Destroy, clear auth, and recreate after auth failure
        setTimeout(async () => {
            console.log('🔄 Recreating after auth failure...');
            logToFile('Recreating after auth failure');
            try {
                await client.destroy();
            } catch (err) {
                logToFile(`Client destroy error: ${err.message}`);
            }

            // Clear auth folder to force new QR code
            const authPath = getAuthPath();
            logToFile(`Clearing auth folder: ${authPath}`);
            try {
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    logToFile('Cleared auth folder');
                }
            } catch (err) {
                logToFile(`Failed to clear auth folder: ${err.message}`);
            }

            client = null;
            initWhatsAppClient();
        }, 3000);
    });

    // =============================
    // Logout Handler (From WhatsApp internal)
    // =============================
    client.on('logout', async (reason) => {
        logToFile(`🚪 WhatsApp logged out (Internal event): ${reason}`, "system");

        // If we are already mid-logout-cleanup, don't double dip
        if (!isClientReady && !isAuthenticating && client === null) return;

        isClientReady = false;
        isAuthenticating = false;
        qrCodeData = null;

        // Stop automation
        if (isAutomationRunning) {
            isAutomationRunning = false;
            if (automationAbortController) automationAbortController.abort();
            if (mainWindow) mainWindow.webContents.send('automation-status-changed', { isRunning: false });
        }

        if (mainWindow) {
            mainWindow.webContents.send('whatsapp-status-updated', { isClientReady: false, qrCode: null });
        }

        // Cleanup and restart
        setTimeout(async () => {
            logToFile('🔄 Auto-cleaning after internal logout event...');
            try {
                if (client) {
                    await client.destroy().catch(() => { });
                    client = null;
                }
                await forceKillBrowser(); // Extra safety
            } catch (e) { }

            // Definitively reset flags before re-init
            isClientReady = false;
            isAuthenticating = false;
            initWhatsAppClient();
        }, 1500); // Shorter delay
    });

    // =============================
    // Initialize WhatsApp Client (with retry)
    // =============================
    const MAX_RETRIES = 3;
    let retryCount = 0;

    async function tryInitialize() {
        try {
            await client.initialize();
            isInitializingClient = false;
        } catch (error) {
            isInitializingClient = false;
            logToFile(`Failed to initialize WhatsApp client: ${error.message}`);

            // Handle critical "Execution context was destroyed" or navigation errors
            const errorMsg = error.message.toLowerCase();
            if (errorMsg.includes('execution context was destroyed') ||
                errorMsg.includes('navigating to') ||
                errorMsg.includes('target closed') ||
                errorMsg.includes('already running') ||
                errorMsg.includes('profile in use')) {

                // Skip recovery if we're already handling a reconnect (e.g. browser toggle)
                if (isReconnecting) {
                    logToFile('Skipping recovery — reconnect already in progress.', 'warning');
                    return;
                }

                const isConflict = errorMsg.includes('already running') || errorMsg.includes('profile in use');
                if (isConflict) {
                    logToFile('⚔️ CONFLICT DETECTED: Browser is already running. Auto-killing lingering processes...', 'warning');
                    await forceKillBrowser();
                } else {
                    logToFile('🧪 Recovery trigger: Retrying initialization due to browser instance crash...', 'warning');
                }

                // Reset states to allow new QR if needed
                isAuthenticating = false;
                isClientReady = false;

                setTimeout(() => {
                    tryInitialize();
                }, isConflict ? 3000 : 2000);
                return;
            }

            // Retry on connection errors
            if (error.message.includes('ERR_CONNECTION_RESET') ||
                error.message.includes('ERR_CONNECTION_REFUSED') ||
                error.message.includes('ERR_NAME_NOT_RESOLVED') ||
                error.message.includes('net::')) {
                retryCount++;
                if (retryCount <= MAX_RETRIES) {
                    logToFile(`🔄 Retrying WhatsApp connection (${retryCount}/${MAX_RETRIES}) in 15 seconds...`, 'warning');
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('whatsapp-error', {
                            message: `Connection failed. Retrying ${retryCount}/${MAX_RETRIES}...`
                        });
                    }
                    setTimeout(() => {
                        tryInitialize();
                    }, 15000);
                    return;
                }
                logToFile(`❌ WhatsApp connection failed after ${MAX_RETRIES} retries. Check internet/firewall.`, 'error');
            }

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('whatsapp-error', { message: error.message });
            }
        }
    }

    tryInitialize();
}
// Create the main browser window
function createMainWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        show: false, // hide until content is ready to prevent white flash
        backgroundColor: '#030407', // match app background so no flash even if delayed
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    // Show window only when fully rendered — eliminates white flash on startup
    win.once('ready-to-show', () => {
        win.show();
    });

    // Load the local HTML file directly
    win.loadFile('index.html');

    // Handle window close event
    win.on('close', (event) => {
        if (!isShuttingDown) {
            // App will quit via window-all-closed
        }
    });

    // Open dev tools in development
    if (process.env.NODE_ENV === 'development') {
        win.webContents.openDevTools();
    }

    return win;
}

// Create custom application menu
function createApplicationMenu() {
    const template = [
        {
            label: 'App',
            submenu: [
                {
                    label: 'Dashboard',
                    accelerator: 'CmdOrCtrl+D',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.loadFile('index.html');
                        }
                    }
                },
                {
                    label: 'About',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.loadFile('about.html');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Reload App',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.reload();
                        }
                    }
                },
                { type: 'separator' },
                { role: 'quit', label: 'Exit' }
            ]
        },
        {
            label: 'WhatsApp',
            submenu: [
                {
                    label: 'Reconnect WhatsApp',
                    click: async () => {
                        if (client) {
                            logToFile('Manual reconnect requested from menu', "system");
                            try {
                                await client.destroy();
                            } catch (err) {
                                logToFile(`Destroy error: ${err.message}`);
                            }
                            const authPath = getAuthPath();
                            try {
                                if (fs.existsSync(authPath)) {
                                    fs.rmSync(authPath, { recursive: true, force: true });
                                    logToFile('Cleared auth for manual reconnect');
                                }
                            } catch (err) {
                                logToFile(`Clear auth error: ${err.message}`);
                            }
                            client = null;
                            isClientReady = false;
                            qrCodeData = null;
                            if (mainWindow) {
                                mainWindow.webContents.send('whatsapp-status-updated', { isClientReady: false, qrCode: null });
                            }
                            initWhatsAppClient();
                        } else {
                            // If client doesn't exist but user wants to reconnect, 
                            // still try to kill processes and clear auth
                            await forceKillBrowser();
                            const authPath = getAuthPath();
                            if (fs.existsSync(authPath)) {
                                try {
                                    fs.rmSync(authPath, { recursive: true, force: true });
                                    logToFile('Cleared auth for manual reconnect (force)');
                                } catch (e) { }
                            }
                            initWhatsAppClient();
                        }
                    }
                },
                {
                    label: 'Logout & Force Clear Session',
                    click: async () => {
                        logToFile('Manual logout & force clear requested');
                        if (isAutomationRunning) {
                            isAutomationRunning = false;
                            if (automationAbortController) {
                                automationAbortController.abort();
                            }
                            if (mainWindow) {
                                mainWindow.webContents.send('automation-status-changed', { isRunning: false });
                            }
                        }

                        // 1. Force kill browser processes first
                        await forceKillBrowser();

                        if (client) {
                            try {
                                // Don't await logout if we just taskkilled, might hang
                                client.logout().catch(() => { });
                            } catch (err) { }
                        }

                        logToFile('✅ Session forced clear. Please restart the app or reconnect.');
                    }
                },
                { type: 'separator' },
                {
                    label: browserVisible ? 'Hide External Browser' : 'Show External Browser',
                    click: async () => {
                        browserVisible = !browserVisible;
                        logToFile(browserVisible ? 'Showing external browser...' : 'Hiding external browser...', 'system');

                        // Rebuild menu to update label
                        createApplicationMenu();

                        // Restart WhatsApp client with new headless setting
                        isReconnecting = true;
                        isAuthenticating = false;
                        isClientReady = false;
                        qrCodeData = null;

                        if (isAutomationRunning) {
                            isAutomationRunning = false;
                            if (automationAbortController) automationAbortController.abort();
                            if (mainWindow) mainWindow.webContents.send('automation-status-changed', { isRunning: false });
                        }

                        if (client) {
                            try { await client.destroy(); } catch (e) { }
                            client = null;
                        }

                        await forceKillBrowser();

                        if (mainWindow) {
                            mainWindow.webContents.send('whatsapp-status-updated', { isClientReady: false, qrCode: null });
                        }

                        // Allow recovery logic to work again, then reinitialize
                        setTimeout(() => {
                            isReconnecting = false;
                            initWhatsAppClient();
                        }, 2000);
                    }
                },
                { type: 'separator' },
                {
                    label: 'Connection Status',
                    enabled: false,
                    click: () => { }
                }
            ]
        },
        {
            label: 'Automation',
            submenu: [
                {
                    label: 'Retry All Failed Messages',
                    click: async () => {
                        if (!db) {
                            logToFile('Cannot retry: Database not connected');
                            return;
                        }
                        try {
                            logToFile('🔄 Resetting failed messages status for retry...', "system");
                            // Mark both 'f' (failed) and 'INVALID' (if user wants to retry them) as NULL
                            await db.execute(`UPDATE [SendQ] SET [Status] = NULL WHERE [Status] = 'f' OR [Status] = 'INVALID'`);
                            logToFile('✅ Failed messages have been reset. They will be picked up by automation.', "success");
                            updateStatsAndSendToRenderer();
                        } catch (err) {
                            logToFile(`❌ Error resetting failed messages: ${err.message}`, "error");
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Start Automation',
                    click: () => {
                        if (!isClientReady) {
                            logToFile('Cannot start automation: WhatsApp not connected');
                            return;
                        }
                        if (!isAutomationRunning) {
                            isAutomationRunning = true;
                            automationAbortController = new AbortController();
                            if (mainWindow) {
                                mainWindow.webContents.send('automation-status-changed', { isRunning: true });
                            }
                            processMessages();
                            logToFile('Automation started from menu');
                        }
                    }
                },
                {
                    label: 'Stop Automation',
                    click: () => {
                        if (isAutomationRunning) {
                            isAutomationRunning = false;
                            if (automationAbortController) {
                                automationAbortController.abort();
                            }
                            if (mainWindow) {
                                mainWindow.webContents.send('automation-status-changed', { isRunning: false });
                            }
                            logToFile('Automation stopped from menu');
                        }
                    }
                }
            ]
        },
        {
            label: 'Tools',
            submenu: [
                {
                    label: 'Open Log File',
                    click: () => {
                        const logPath = path.join(app.getPath('userData'), 'app.log');
                        if (fs.existsSync(logPath)) {
                            require('child_process').exec(`notepad "${logPath}"`);
                        } else {
                            logToFile('Log file not found');
                        }
                    }
                },
                {
                    label: 'Open App Data Folder',
                    click: () => {
                        require('child_process').exec(`explorer "${app.getPath('userData')}"`);
                    }
                },
                { type: 'separator' },
                {
                    label: 'Force Kill Browser Processes',
                    click: async () => {
                        await forceKillBrowser();
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'Cleanup Complete',
                            message: 'Lingering browser processes have been terminated.',
                            detail: 'You can now safely restart the WhatsApp connection.'
                        });
                    }
                },
                {
                    label: 'Clear All Sessions (Total Reset)',
                    click: async () => {
                        const confirm = await dialog.showMessageBox(mainWindow, {
                            type: 'warning',
                            title: 'Total Reset',
                            message: 'This will force kill browsers and DELETE all login data. Continue?',
                            buttons: ['Yes', 'No']
                        });

                        if (confirm.response === 0) {
                            await forceKillBrowser();
                            const authPath = getAuthPath();
                            try {
                                if (fs.existsSync(authPath)) {
                                    fs.rmSync(authPath, { recursive: true, force: true });
                                    logToFile('✅ All sessions cleared forcefully');
                                }
                            } catch (err) {
                                logToFile(`Failed to clear sessions: ${err.message}`);
                            }
                        }
                    }
                }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom', label: 'Reset Zoom' },
                { role: 'zoomIn', label: 'Zoom In' },
                { role: 'zoomOut', label: 'Zoom Out' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: 'Fullscreen' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize', label: 'Minimize' },
                { role: 'close', label: 'Close' }
            ]
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}





app.whenReady().then(() => {
    // Create the main window
    mainWindow = createMainWindow();

    // Create the menu
    createApplicationMenu();

    // Initialize the database on startup and auto-start WhatsApp client
    setTimeout(async () => {
        await initDatabase();
        logToFile('✅ Database ready. Auto-initializing WhatsApp client...');
        initWhatsAppClient();
    }, 100);
});

// Handle window closed
if (mainWindow) {
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Handle IPC communication
ipcMain.on('request-initial-status', (event) => {
    // Send initial status when page loads
    event.sender.send('whatsapp-status-updated', {
        isClientReady,
        qrCode: qrCodeData
    });

    // Also send automation status
    event.sender.send('automation-status-changed', {
        isRunning: isAutomationRunning
    });

    // Send stats update
    updateStatsAndSendToRenderer();

    // Replay buffered logs
    logBuffer.forEach(log => {
        event.sender.send('app-log', log);
    });
});

// Handle automation start/stop via IPC
ipcMain.handle('start-automation', async (event) => {
    if (!isClientReady) {
        return { success: false, message: 'WhatsApp not connected' };
    }

    if (isAutomationRunning) {
        return { success: false, message: 'Automation already running' };
    }

    try {
        isAutomationRunning = true;
        automationAbortController = new AbortController();

        // Send status to renderer
        if (mainWindow) {
            mainWindow.webContents.send('automation-status-changed', { isRunning: true });
        }

        // Run automation in background
        processMessages();

        return { success: true, message: 'Automation started' };
    } catch (error) {
        console.error('Error starting automation:', error);
        isAutomationRunning = false;
        return { success: false, message: 'Error starting automation' };
    }
});

ipcMain.handle('stop-automation', async (event) => {
    if (!isAutomationRunning) {
        return { success: false, message: 'Automation not running' };
    }

    try {
        isAutomationRunning = false;
        if (automationAbortController) {
            automationAbortController.abort();
        }

        // Send status to renderer
        if (mainWindow) {
            mainWindow.webContents.send('automation-status-changed', { isRunning: false });
        }

        return { success: true, message: 'Automation stopped' };
    } catch (error) {
        console.error('Error stopping automation:', error);
        return { success: false, message: 'Error stopping automation' };
    }
});

// Handle logout via IPC
ipcMain.handle('logout-whatsapp', async () => {
    if (!client) {
        logToFile('ℹ️ Logout requested but client not running. Attempting fresh start...');
        initWhatsAppClient();
        return { success: true };
    }

    logToFile('🚪 Manual logout initiated from UI...', 'warning');

    // Immediate state reset to stop any blocking
    isClientReady = false;
    isAuthenticating = false;
    qrCodeData = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whatsapp-status-updated', { isClientReady: false, qrCode: null });
    }

    // Stop automation
    if (isAutomationRunning) {
        isAutomationRunning = false;
        if (automationAbortController) automationAbortController.abort();
        if (mainWindow) mainWindow.webContents.send('automation-status-changed', { isRunning: false });
    }

    try {
        // Attempt clean logout
        logToFile('📡 Attempting clean termination via client.logout()...');
        await client.logout().catch(e => logToFile(`Logout command error (ignoring): ${e.message}`));

        // Wait 2.5 seconds to allow file locks to release and browser to close
        setTimeout(async () => {
            logToFile('🧹 Hard-cleaning remaining session data...');
            try {
                if (client) {
                    await client.destroy().catch(() => { });
                    client = null;
                }
                await forceKillBrowser();
            } catch (e) { }

            const authPath = getAuthPath();
            if (fs.existsSync(authPath)) {
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    logToFile('✅ Auth folder cleared successfully');
                } catch (e) { }
            }

            // Final state reset just before recreation
            isClientReady = false;
            isAuthenticating = false;
            qrCodeData = null;

            initWhatsAppClient(); // This will trigger a NEW QR
        }, 2500);

        return { success: true };
    } catch (err) {
        logToFile(`❌ Logout failed: ${err.message}. Forcing restart...`, 'error');
        await forceKillBrowser();
        client = null;
        initWhatsAppClient();
        return { success: false, message: err.message };
    }
});


// Handle manual database refresh via IPC
ipcMain.handle('refresh-database', async () => {
    try {
        logToFile('🔄 Manual database refresh requested', "system");
        await initDatabase();
        return { success: true };
    } catch (err) {
        logToFile(`❌ Manual refresh error: ${err.message}`, "error");
        return { success: false, message: err.message };
    }
});

// Set up periodic updates — FAST timer for UI countdown, SLOW timer for DB queries
// Fast timer: sends cached stats + countdown to UI every 1 second (no DB read = no lag)
let cachedPendingCount = 0;
let cachedSentCount = 0;
let cachedFailedCount = 0;

setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('stats-updated', {
        pendingCount: cachedPendingCount,
        sentCount: cachedSentCount,
        failedCount: cachedFailedCount,
        isWaiting: isWaiting,
        nextSendTime: nextSendTime,
        // currentBatchCount: currentBatchCount, // Removed per user request
        // lastCooldownTime: lastCooldownTime, // Removed per user request
        delaySettings: delaySettings,
        dbStatus: db ? 'Connected' : 'Not Connected'
    });
}, 1000); 

// Slow timer: re-read DB stats every 5 seconds so pending count stays live
// (shadow copy reads are lock-safe, so this won't cause locking issues)
setInterval(async () => {
    if (!db) return;
    try {
        await updateStatsAndSendToRenderer();
    } catch (e) { /* ignore */ }
}, 5000);

// Heartbeat monitoring for 24/7 operation
setInterval(heartbeatCheck, 60000); // Check every 60 seconds (reduced from 30s)

// Periodic lock cleanup (Ensures no cscript.exe is lingering to hold DB locks)
setInterval(() => {
    if (app.isPackaged || process.env.NODE_ENV !== 'development') {
        spawn('cmd.exe', ['/c', 'taskkill /F /IM cscript.exe /T'], { windowsHide: true });
    }
}, 900000); // Every 15 minutes (increased from 5 to be safer)

// Heartbeat function to monitor connection health
function heartbeatCheck() {
    if (isClientReady && client) {
        const now = Date.now();
        const timeSinceLastHeartbeat = now - lastHeartbeat;

        // If no authentic heartbeat from getState() for more than 15 minutes, trigger reconnect
        if (timeSinceLastHeartbeat > 900000) {
            logToFile('⚠️ No heartbeat detected for 15 minutes, triggering force reconnect', 'warning');
            console.log('⚠️ No heartbeat detected for 15 minutes, triggering force reconnect');
            if (!isReconnecting) {
                isReconnecting = true;
                
                // Forceful cleanup because the client may hang on destroy()
                setTimeout(async () => {
                    await forceKillBrowser();
                    isReconnecting = false;
                    initWhatsAppClient();
                }, 2000);
                
                try {
                    client.destroy().catch(() => {});
                } catch (e) {}
                client = null;
            }
        }
        // Removed the artificial update logic that tricked the system into never disconnecting
    }
}

// Periodic connection validation via actual WhatsApp internals
setInterval(async () => {
    if (isClientReady && client && !isReconnecting) {
        try {
            // getState() is the true source of connection validity
            const state = await client.getState();
            if (state === 'CONNECTED') {
                 lastHeartbeat = Date.now(); // Only update on successful confirmation
            } else {
                 throw new Error(`State is ${state}`);
            }
        } catch (err) {
            logToFile(`Connection validation failed: ${err.message}`, 'warning');
            console.log(`⚠️ Connection validation failed: ${err.message}`);
            if (!isReconnecting) {
                isReconnecting = true;
                
                setTimeout(async () => {
                    await forceKillBrowser();
                    isReconnecting = false;
                    initWhatsAppClient();
                }, 2000);

                try {
                    client.destroy().catch(() => {});
                } catch (e) {}
                client = null;
            }
        }
    }
}, 120000); // Check every 2 minutes

// Function to update stats from DB (runs every 10 seconds — heavy I/O)
async function updateStatsAndSendToRenderer() {
    if (!db) return;

    try {
        // Auto-refresh if file changed while idle in dashboard
        if (dbPathGlobal && fs.existsSync(dbPathGlobal)) {
            const currentMtime = fs.statSync(dbPathGlobal).mtimeMs;
            if (currentMtime > lastDbMtime && !isAutomationRunning) {
                // Silently refresh in background
                await initDatabase();
            }
        }

        // Get statistics from a SINGLE query to minimize file hits
        // We use Shadow Copy for this.
        const allRows = await db.query(`SELECT Status FROM [SendQ]`);

        const pendingCount = allRows.filter(r => !r.Status || r.Status === null || r.Status.toString().trim() === '').length;
        const sentCount = allRows.filter(r => r.Status && r.Status.toString().trim().toLowerCase() === 's').length;
        const failedCount = allRows.filter(r => r.Status && (r.Status.toString().trim().toLowerCase() === 'f' || r.Status.toString().trim().toUpperCase() === 'INVALID')).length;

        // Only log when counts change to reduce terminal spam
        if (pendingCount !== cachedPendingCount || sentCount !== cachedSentCount || failedCount !== cachedFailedCount) {
            console.log(`📊 Total Pending: ${pendingCount} | Total Sent: ${sentCount} | Total Failed: ${failedCount}`);
        }

        // Update cache (the fast 1-second timer reads from these)
        cachedPendingCount = pendingCount;
        cachedSentCount = sentCount;
        cachedFailedCount = failedCount;

        // AUTO-RESTART: If there are pending messages but automation stopped, restart it
        if (pendingCount > 0 && !isAutomationRunning && isClientReady && !isReconnecting) {
            sendLog(`🔄 Pending messages detected (${pendingCount}). Auto-restarting automation...`, "system");
            isAutomationRunning = true;
            automationAbortController = new AbortController();
            hasLoggedNoPending = false;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('automation-status-changed', { isRunning: true });
            }
            processMessages();
        }
    } catch (err) {
        logToFile(`📊 Stats error: ${err.message}`, "warning");
    }
}

// Quit when all windows are closed
app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when
    // the dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
    }
});

// Handle app quit with graceful shutdown
app.on('before-quit', async (event) => {
    if (isShuttingDown) return;
    event.preventDefault();
    await gracefulShutdown('before-quit');
    app.exit(0);
});

// Handle SIGINT and SIGTERM
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await gracefulShutdown('SIGINT');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await gracefulShutdown('SIGTERM');
    process.exit(0);
});