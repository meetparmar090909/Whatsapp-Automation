const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const systemStatus = document.getElementById('system-status');
    const statusText = systemStatus.querySelector('.status-text');
    const pendingCountEl = document.getElementById('pending-count');
    const sentCountEl = document.getElementById('sent-count');
    const failedCountEl = document.getElementById('failed-count');
    const failedTrendEl = document.querySelector('.failed-trend');
    const delayStatusEl = document.getElementById('delay-status');
    const terminalDelayStatusEl = document.getElementById('terminal-delay-status');
    const delayConfigEl = document.getElementById('delay-config');
    const controlFailedCountEl = document.getElementById('control-failed-count');
    const serverDot = document.getElementById('server-dot');
    const terminalOutput = document.getElementById('terminal-output');
    const clearTerminalBtn = document.getElementById('clear-terminal');
    const themeToggleBtn = document.getElementById('theme-toggle');
    const editDelayBtn = document.getElementById('edit-delay-btn');
    const delayDisplay = document.getElementById('delay-display');
    const delayEditForm = document.getElementById('delay-edit-form');
    const minDelayInput = document.getElementById('min-delay-input');
    const maxDelayInput = document.getElementById('max-delay-input');
    const saveDelayBtn = document.getElementById('save-delay-btn');
    const cancelDelayBtn = document.getElementById('cancel-delay-btn');

    // =============================
    // Delay Settings Edit
    // =============================
    if (editDelayBtn) {
        editDelayBtn.addEventListener('click', () => {
            const currentRange = delayConfigEl ? delayConfigEl.textContent.replace('s', '').split('-') : ['60', '120'];
            if (currentRange.length === 2) {
                minDelayInput.value = currentRange[0].trim();
                maxDelayInput.value = currentRange[1].trim();
            }
            if (delayDisplay) delayDisplay.style.display = 'none';
            if (delayEditForm) delayEditForm.style.display = 'flex';
            if (minDelayInput) minDelayInput.focus();
        });
    }

    if (cancelDelayBtn) {
        cancelDelayBtn.addEventListener('click', () => {
            if (delayEditForm) delayEditForm.style.display = 'none';
            if (delayDisplay) delayDisplay.style.display = 'flex';
        });
    }

    if (saveDelayBtn) {
        saveDelayBtn.addEventListener('click', () => {
            const min = parseInt(minDelayInput.value);
            const max = parseInt(maxDelayInput.value);

            if (isNaN(min) || isNaN(max) || min < 0 || max < min) {
                alert('Please enter valid delay values (Max must be >= Min)');
                return;
            }

            // Send to main process
            ipcRenderer.send('update-delay-settings', { min, max });

            // Update UI
            if (delayConfigEl) delayConfigEl.textContent = `${min}-${max}s`;
            if (delayEditForm) delayEditForm.style.display = 'none';
            if (delayDisplay) delayDisplay.style.display = 'flex';
            
            // Log locally for visual feedback
            addLogToUI({
                time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
                message: `✅ Delay updated to ${min}-${max}s`,
                type: 'success'
            });
        });
    }

    // =============================
    // Theme Toggle
    // =============================
    const savedTheme = localStorage.getItem('wa-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('wa-theme', next);
        });
    }

    const qrContainer = document.getElementById('qr-container');
    const qrImage = document.getElementById('qr-image');
    const qrLoader = document.getElementById('qr-loader');
    const whatsappStatus = document.getElementById('whatsapp-status');
    const whatsappStatusText = document.getElementById('whatsapp-status-text');
    const logoutBtn = document.getElementById('logout-btn');

    let qrHideTimeout = null;

    // =============================
    // QR Expiry Countdown
    // =============================
    const qrExpiryWrap = document.getElementById('qr-expiry-wrap');
    const qrExpiryFill = document.getElementById('qr-expiry-fill');
    const qrExpiryLabel = document.getElementById('qr-expiry-label');
    const qrExpirySec = document.getElementById('qr-expiry-sec');
    const QR_EXPIRY_SECONDS = 20;
    let qrCountdownInterval = null;

    function startQrCountdown() {
        stopQrCountdown();
        if (!qrExpiryWrap) return;
        qrExpiryWrap.style.display = 'block';
        let remaining = QR_EXPIRY_SECONDS;

        const update = () => {
            const pct = (remaining / QR_EXPIRY_SECONDS) * 100;
            if (qrExpiryFill) qrExpiryFill.style.width = pct + '%';
            if (qrExpirySec) qrExpirySec.textContent = remaining;

            // Color transitions
            const isExpiring = remaining <= 10;
            const isCritical = remaining <= 5;
            if (qrExpiryFill) {
                qrExpiryFill.className = 'qr-expiry-fill' + (isCritical ? ' critical' : isExpiring ? ' expiring' : '');
            }
            if (qrExpiryLabel) {
                qrExpiryLabel.className = 'qr-expiry-label' + (isCritical ? ' critical' : isExpiring ? ' expiring' : '');
            }
        };

        update();
        qrCountdownInterval = setInterval(() => {
            remaining--;
            if (remaining < 0) {
                stopQrCountdown();
                return;
            }
            update();
        }, 1000);
    }

    function stopQrCountdown() {
        if (qrCountdownInterval) { clearInterval(qrCountdownInterval); qrCountdownInterval = null; }
        if (qrExpiryWrap) qrExpiryWrap.style.display = 'none';
    }

    // =============================
    // Init Steps Sequencer
    // =============================
    let initStepTimer = null;
    function startInitSteps() {
        const steps = ['init-step-1', 'init-step-2', 'init-step-3'];
        let current = 0;
        const el1 = document.getElementById('init-step-1');
        const el2 = document.getElementById('init-step-2');
        const el3 = document.getElementById('init-step-3');
        if (el1) el1.className = 'init-step active';
        if (el2) el2.className = 'init-step';
        if (el3) el3.className = 'init-step';

        if (initStepTimer) clearInterval(initStepTimer);
        initStepTimer = setInterval(() => {
            const prev = document.getElementById(steps[current]);
            if (prev) prev.className = 'init-step done';
            current++;
            if (current >= steps.length) { clearInterval(initStepTimer); return; }
            const next = document.getElementById(steps[current]);
            if (next) next.className = 'init-step active';
        }, 2500);
    }

    function stopInitSteps() {
        if (initStepTimer) { clearInterval(initStepTimer); initStepTimer = null; }
    }

    // Helper: show the "waiting for QR" spinner state
    function showQrLoadingState() {
        if (qrLoader) { qrLoader.style.display = 'flex'; }
        if (qrImage) qrImage.style.display = 'none';
        stopQrCountdown();
        startInitSteps();
    }

    // =============================
    // Custom Logout Modal
    // =============================
    const logoutModal = document.getElementById('logout-modal');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const logoutToast = document.getElementById('logout-toast');
    let pendingLogoutCallback = null;

    function showLogoutModal(onConfirm) {
        pendingLogoutCallback = onConfirm;
        if (logoutModal) logoutModal.classList.add('visible');
    }

    function hideLogoutModal() {
        if (logoutModal) logoutModal.classList.remove('visible');
        if (modalConfirmBtn) {
            modalConfirmBtn.classList.remove('loading');
            modalConfirmBtn.disabled = false;
        }
        pendingLogoutCallback = null;
    }

    function showLogoutToast() {
        if (!logoutToast) return;
        logoutToast.classList.add('show');
        setTimeout(() => logoutToast.classList.remove('show'), 3000);
    }

    if (modalCancelBtn) {
        modalCancelBtn.addEventListener('click', () => hideLogoutModal());
    }

    if (logoutModal) {
        logoutModal.addEventListener('click', (e) => {
            if (e.target === logoutModal) hideLogoutModal();
        });
    }

    if (modalConfirmBtn) {
        modalConfirmBtn.addEventListener('click', async () => {
            if (!pendingLogoutCallback) return;
            modalConfirmBtn.classList.add('loading');
            modalConfirmBtn.disabled = true;
            await pendingLogoutCallback();
            hideLogoutModal();
            showLogoutToast();
        });
    }

    // Logout button handler
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            showLogoutModal(async () => {
                logoutBtn.disabled = true;
                try { await ipcRenderer.invoke('logout-whatsapp'); } catch (e) { console.error('Logout error:', e); }
                setTimeout(() => {
                    logoutBtn.disabled = false;
                    logoutBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg> Logout';
                }, 3000);
            });
        });
    }

    const logoutMainBtn = document.getElementById('logout-main-btn');
    if (logoutMainBtn) {
        logoutMainBtn.addEventListener('click', () => {
            showLogoutModal(async () => {
                logoutMainBtn.disabled = true;
                const originalHTML = logoutMainBtn.innerHTML;
                try { await ipcRenderer.invoke('logout-whatsapp'); } catch (e) { console.error('Logout error:', e); }
                setTimeout(() => {
                    if (logoutMainBtn) { logoutMainBtn.disabled = false; logoutMainBtn.innerHTML = originalHTML; }
                }, 5000);
            });
        });
    }

    // =============================
    // Clock
    // =============================
    function updateClock() {
        const now = new Date();
        const el = document.getElementById('current-time');
        if (el) {
            el.textContent = now.toLocaleDateString('en-IN', {
                weekday: 'long',
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            }) + '  •  ' + now.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    }
    updateClock();
    setInterval(updateClock, 30000);

    // =============================
    // Clear Terminal
    // =============================
    if (clearTerminalBtn) {
        clearTerminalBtn.addEventListener('click', () => {
            typewriterQueue.length = 0;
            terminalOutput.innerHTML = '<div class="log-line system">[cleared]</div>';
        });
    }

    // =============================
    // Dashboard Log UI
    // =============================

    function addLogToUI(log) {
        const div = document.createElement('div');
        div.className = `log-line ${log.type || 'info'}`;
        const timeStr = log.time || new Date().toLocaleTimeString('en-IN', { hour12: false });
        div.textContent = `[${timeStr}] ${log.message}`;
        terminalOutput.appendChild(div);

        // Keep terminal clean - remove old logs if too many
        if (terminalOutput.children.length > 150) {
            terminalOutput.removeChild(terminalOutput.firstChild);
        }

        // Instant scroll to bottom
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    // =============================
    // IPC Event Listeners
    // =============================

    // QR Code Update
    ipcRenderer.on('qr-code-updated', (_event, qrData) => {
        const qrBox = document.querySelector('.qr-box');
        // Hide loader — show the QR image
        qrLoader.style.display = 'none';
        qrImage.src = qrData;
        qrImage.style.display = 'block';
        if (qrBox) qrBox.classList.add('has-qr');

        // Start expiry countdown (QR codes expire ~20s)
        stopInitSteps();
        startQrCountdown();

        // Ensure connected overlay is hidden and reset
        const qrConnected = document.getElementById('qr-connected');
        if (qrConnected) {
            qrConnected.style.display = 'none';
            qrConnected.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                    <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span>Device Connected</span>
            `;
        }
        if (qrBox) qrBox.classList.remove('is-connected', 'is-link-active');

        // Force QR container to show if we just got a QR
        if (qrContainer) {
            if (qrHideTimeout) clearTimeout(qrHideTimeout);
            qrContainer.style.display = 'flex';
            qrContainer.style.opacity = '1';
            qrContainer.style.transform = 'scale(1)';
        }
    });

    // WhatsApp Status Update
    ipcRenderer.on('whatsapp-status-updated', (_event, data) => {
        const qrBox = document.querySelector('.qr-box');
        const qrConnected = document.getElementById('qr-connected');
        const qrSteps = document.querySelector('.qr-steps');

        const isLinking = data.isAuthenticating && !data.isClientReady;
        const isReady = data.isClientReady;

        if (isReady || isLinking) {
            stopQrCountdown();
            stopInitSteps();
            whatsappStatus.className = `conn-dot ${isReady ? 'connected' : 'warning'}`;
            whatsappStatusText.textContent = isReady ? 'Connected' : 'Linking...';
            whatsappStatusText.style.color = isReady ? '#25d366' : '#f5a623';

            qrImage.style.display = 'none';
            qrImage.src = ''; // Clear source to prevent any flashing
            qrLoader.style.display = 'none';

            // Hide small qr-connected overlay — full panels take over
            if (qrConnected) qrConnected.style.display = 'none';
            if (qrBox) { qrBox.classList.remove('has-qr', 'is-link-active', 'is-connected'); qrBox.style.borderColor = ''; }
            if (qrSteps) qrSteps.style.display = 'none';

            const qrContent = qrContainer ? qrContainer.querySelector('.qr-content') : null;
            const qrContentRow = qrContainer ? qrContainer.querySelector('.qr-content-row') : null;
            const expiryWrapEl = document.getElementById('qr-expiry-wrap');

            // --- LINKING FULL PANEL ---
            if (isLinking && !document.getElementById('full-linking-panel')) {
                // Remove connected panel if somehow present
                const oldConn = document.getElementById('full-connected-panel');
                if (oldConn) oldConn.remove();

                if (qrContentRow) qrContentRow.style.display = 'none';
                if (expiryWrapEl) expiryWrapEl.style.display = 'none';
                if (qrContent) qrContent.classList.add('linking-mode');

                const linkPanel = document.createElement('div');
                linkPanel.className = 'full-linking-panel';
                linkPanel.id = 'full-linking-panel';
                linkPanel.innerHTML = `
                    <div class="flp-bg-pulse"></div>
                    <div class="flp-rings-wrap">
                        <div class="flp-ring flp-ring-outer"></div>
                        <div class="flp-ring flp-ring-mid"></div>
                        <div class="flp-ring flp-ring-inner-r"></div>
                        <div class="flp-icon-center">
                            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                                <line x1="12" y1="18" x2="12.01" y2="18"></line>
                            </svg>
                        </div>
                    </div>
                    <div class="flp-badge"><span class="flp-badge-dot"></span>SYNCING</div>
                    <div class="flp-percent-big"><span id="flp-percent-num">0</span><span class="flp-pct-sym">%</span></div>
                    <p class="flp-msg" id="flp-msg">Syncing your data...</p>
                    <div class="flp-bar-wrap">
                        <div class="flp-bar-fill" id="flp-bar-fill" style="width:0%"></div>
                    </div>
                    <div class="flp-steps-row">
                        <div class="flp-step flp-step-done">
                            <span class="flp-step-icon">✓</span>QR Scanned
                        </div>
                        <div class="flp-step flp-step-active">
                            <span class="flp-step-icon flp-step-spin">⟳</span>Syncing Data
                        </div>
                        <div class="flp-step" id="flp-step-ready">
                            <span class="flp-step-icon">○</span>Ready
                        </div>
                    </div>
                `;
                if (qrContent) qrContent.appendChild(linkPanel);
            }

            // Clean up linking panel if now ready
            if (isReady) {
                const oldLink = document.getElementById('full-linking-panel');
                if (oldLink) oldLink.remove();
                if (qrContent) qrContent.classList.remove('linking-mode');
            }
            if (logoutBtn) logoutBtn.style.display = isReady ? 'inline-flex' : 'none';
            if (logoutMainBtn) logoutMainBtn.style.display = isReady ? 'inline-flex' : 'none';

            // Show user info if ready
            const userInfo = document.getElementById('user-info');
            const userNameEl = document.getElementById('user-name');
            if (userInfo && userNameEl) {
                if (isReady && data.userName) {
                    userNameEl.textContent = data.userName;
                    userInfo.style.display = 'flex';
                } else {
                    userInfo.style.display = 'none';
                }
            }

            if (qrContainer) {
                // Clear any pending hide animation
                if (qrHideTimeout) clearTimeout(qrHideTimeout);

                if (isReady) {
                    // Switch to full-panel connected celebration view
                    const connectedTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                    const displayName = data.userName || 'WhatsApp User';
                    const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

                    // Remove linking panel if present
                    const oldLink = document.getElementById('full-linking-panel');
                    if (oldLink) oldLink.remove();

                    // Expand qr-content to full-panel mode
                    const qrContent = qrContainer.querySelector('.qr-content');
                    if (qrContent) { qrContent.classList.remove('linking-mode'); qrContent.classList.add('connected-mode'); }
                    const qrContentRow = qrContainer.querySelector('.qr-content-row');
                    if (qrContentRow) qrContentRow.style.display = 'none';
                    const expiryWrap = document.getElementById('qr-expiry-wrap');
                    if (expiryWrap) expiryWrap.style.display = 'none';

                    // Inject full-panel connected UI
                    const connectedPanel = document.createElement('div');
                    connectedPanel.className = 'full-connected-panel';
                    connectedPanel.id = 'full-connected-panel';
                    connectedPanel.innerHTML = `
                        <div class="fcp-glow"></div>
                        <div class="fcp-particles">
                            <span></span><span></span><span></span><span></span><span></span><span></span>
                        </div>
                        <div class="fcp-avatar">${initials}</div>
                        <div class="fcp-badge">
                            <span class="fcp-badge-dot"></span>
                            CONNECTED
                        </div>
                        <h2 class="fcp-name">${displayName}</h2>
                        <p class="fcp-sub">Session active & secured · ${connectedTime}</p>
                        <div class="fcp-stats">
                            <div class="fcp-stat">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                                <span>End-to-end encrypted</span>
                            </div>
                            <div class="fcp-stat">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                                <span>Session ready</span>
                            </div>
                        </div>
                        <div class="fcp-progress-wrap">
                            <div class="fcp-progress-bar" id="fcp-progress-bar"></div>
                        </div>
                        <span class="fcp-dismiss-hint">Closing in <b id="fcp-countdown">5</b>s</span>
                    `;
                    if (qrContent) qrContent.appendChild(connectedPanel);

                    // Countdown + dismiss
                    let count = 5;
                    const countEl = document.getElementById('fcp-countdown');
                    const progBar = document.getElementById('fcp-progress-bar');
                    if (progBar) progBar.style.width = '100%';

                    const countInterval = setInterval(() => {
                        count--;
                        if (countEl) countEl.textContent = count;
                        if (progBar) progBar.style.width = (count / 5 * 100) + '%';
                        if (count <= 0) clearInterval(countInterval);
                    }, 1000);

                    qrHideTimeout = setTimeout(() => {
                        qrContainer.style.opacity = '0';
                        qrContainer.style.transform = 'translateY(-8px) scale(0.98)';
                        qrHideTimeout = setTimeout(() => {
                            qrContainer.style.display = 'none';
                            // Restore layout for potential reconnect
                            if (qrContent) qrContent.classList.remove('connected-mode');
                            if (qrContentRow) qrContentRow.style.display = '';
                            const panel = document.getElementById('full-connected-panel');
                            if (panel) panel.remove();
                            if (qrBox) { qrBox.classList.remove('is-connected', 'is-link-active'); qrBox.style.borderColor = ''; }
                            qrContainer.style.opacity = '';
                            qrContainer.style.transform = '';
                            qrHideTimeout = null;
                        }, 400);
                    }, 5000);
                } else {
                    qrContainer.style.display = 'flex';
                    qrContainer.style.opacity = '1';
                    qrContainer.style.transform = 'scale(1)';
                }
            }
        } else {
            // Disconnected / not connected: show status text and restore generate screen
            whatsappStatus.className = 'conn-dot disconnected';
            whatsappStatusText.textContent = 'Not connected';
            whatsappStatusText.style.color = '#ef4444';

            if (qrContainer) {
                if (qrHideTimeout) clearTimeout(qrHideTimeout);
                qrContainer.style.display = 'flex';
                qrContainer.style.opacity = '1';
                qrContainer.style.transform = 'scale(1)';

                // Clean up any full panels and restore layout
                const flpPanel = document.getElementById('full-linking-panel');
                const fcpPanel = document.getElementById('full-connected-panel');
                const qcRow = qrContainer.querySelector('.qr-content-row');
                const qcContent = qrContainer.querySelector('.qr-content');
                if (flpPanel) flpPanel.remove();
                if (fcpPanel) fcpPanel.remove();
                if (qcRow) qcRow.style.display = '';
                if (qcContent) qcContent.classList.remove('linking-mode', 'connected-mode');
            }
            if (qrConnected) qrConnected.style.display = 'none';
            if (qrBox) { qrBox.classList.remove('is-connected', 'is-link-active'); qrBox.style.borderColor = ''; }
            if (qrSteps) qrSteps.style.display = 'flex';
            if (logoutBtn) logoutBtn.style.display = 'none';
            if (logoutMainBtn) logoutMainBtn.style.display = 'none';

            const userInfo = document.getElementById('user-info');
            if (userInfo) userInfo.style.display = 'none';

            if (data.qrCode) {
                // QR already exists — show it
                qrImage.src = data.qrCode;
                qrImage.style.display = 'block';
                qrLoader.style.display = 'none';
                if (qrBox) qrBox.classList.add('has-qr');
            } else {
                // No QR yet — show loading spinner
                showQrLoadingState();
                if (qrBox) qrBox.classList.remove('has-qr');
            }
        }
    });

    // WhatsApp Loading Progress
    ipcRenderer.on('whatsapp-loading', (_event, data) => {
        const pct = data.percent || 0;
        if (whatsappStatusText) {
            whatsappStatusText.textContent = `Syncing (${pct}%)...`;
        }

        // Update full linking panel
        const percentNum = document.getElementById('flp-percent-num');
        const barFill = document.getElementById('flp-bar-fill');
        const msgEl = document.getElementById('flp-msg');

        if (percentNum) percentNum.textContent = pct;
        if (barFill) barFill.style.width = pct + '%';
        if (msgEl) msgEl.textContent = data.message || 'Syncing your data...';

        // Mark "Ready" step when nearly done
        if (pct >= 90) {
            const readyStep = document.getElementById('flp-step-ready');
            if (readyStep) readyStep.className = 'flp-step flp-step-active';
        }
    });

    // Automation Status Update
    ipcRenderer.on('automation-status-changed', (_event, data) => {
        if (data.isRunning) {
            systemStatus.classList.add('running');
            statusText.textContent = 'Running';
        } else {
            systemStatus.classList.remove('running');
            statusText.textContent = 'Stopped';
        }
    });

    // Stats Update
    ipcRenderer.on('stats-updated', (_event, data) => {
        if (serverDot) serverDot.classList.add('active'); // Server is active if we get stats
        if (pendingCountEl) pendingCountEl.textContent = data.pendingCount;
        if (sentCountEl) sentCountEl.textContent = data.sentCount.toLocaleString();
        if (failedCountEl) failedCountEl.textContent = data.failedCount || 0;

        if (failedTrendEl) {
            failedTrendEl.textContent = 'Errors';
        }

        if (delayStatusEl || terminalDelayStatusEl) {
            if (data.isWaiting && data.nextSendTime) {
                const remaining = Math.max(0, Math.ceil((data.nextSendTime - Date.now()) / 1000));
                const isSearching = data.pendingCount === 0;
                const statusStr = isSearching ? `Searching (${remaining}s)` : `Waiting (${remaining}s)`;

                if (delayStatusEl) {
                    delayStatusEl.textContent = statusStr;
                    delayStatusEl.style.color = 'var(--yellow)';
                }
                if (terminalDelayStatusEl) {
                    terminalDelayStatusEl.textContent = `(${statusStr})`;
                    terminalDelayStatusEl.style.color = 'var(--yellow)';
                }
            } else if (systemStatus.classList.contains('running')) {
                const statusStr = data.pendingCount > 0 ? 'Sending...' : 'Syncing...';
                if (delayStatusEl) {
                    delayStatusEl.textContent = statusStr;
                    delayStatusEl.style.color = 'var(--green)';
                }
                if (terminalDelayStatusEl) {
                    terminalDelayStatusEl.textContent = '(Processing)';
                    terminalDelayStatusEl.style.color = 'var(--green)';
                }
            } else {
                if (delayStatusEl) {
                    delayStatusEl.textContent = 'Idle';
                    delayStatusEl.style.color = '';
                }
                if (terminalDelayStatusEl) {
                    terminalDelayStatusEl.textContent = '(Idle)';
                    terminalDelayStatusEl.style.color = '';
                }
            }
        }

        if (delayConfigEl && data.delaySettings) {
            // Only update if not currently editing
            if (delayEditForm && delayEditForm.style.display !== 'flex') {
                delayConfigEl.textContent = `${data.delaySettings.min}-${data.delaySettings.max}s`;
            }
        }

        // if (batchCountEl) {
        //     batchCountEl.textContent = `${data.currentBatchCount || 0} / 25`;
        // }

        if (controlFailedCountEl) {
            controlFailedCountEl.textContent = data.failedCount || 0;
        }
    });

    // App Logs
    ipcRenderer.on('app-log', (_event, log) => {
        addLogToUI(log);
    });

    // WhatsApp Errors
    ipcRenderer.on('whatsapp-error', (_event, data) => {
        addLogToUI({
            time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
            message: `CRITICAL ERROR: ${data.message}`,
            type: 'error'
        });
    });

    // =============================
    // Initialization
    // =============================
    // Request initial status from main process
    ipcRenderer.send('request-initial-status');

    addLogToUI({
        time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
        message: 'Dashboard initialized.',
        type: 'system'
    });
});
