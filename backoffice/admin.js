'use strict';

(function () {
    const $ = (id) => document.getElementById(id);

    const loginView = $('login-view');
    const dashboard = $('dashboard');
    const loginForm = $('login-form');
    const loginUsername = $('login-username');
    const loginPassword = $('login-password');
    const loginError = $('login-error');
    const loginSubmit = $('login-submit');
    const logoutBtn = $('logout-btn');

    const addForm = $('add-form');
    const titleInput = $('title-input');
    const imageInput = $('image-input');
    const animationInput = $('animation-input');
    const imageName = $('image-name');
    const animationName = $('animation-name');
    const imagePreview = $('image-preview');
    const animationPreview = $('animation-preview');
    const addError = $('add-error');
    const addSubmit = $('add-submit');

    const targetsList = $('targets-list');
    const emptyTargets = $('empty-targets');
    const targetCount = $('target-count');
    const jobsList = $('jobs-list');
    const jobsBadge = $('jobs-badge');
    const refreshBtn = $('refresh-btn');
    const toastEl = $('toast');

    const state = {
        targets: [],
        jobs: [],
        timer: null,
        hadPending: false,
        toastTimer: null,
        imageUrl: '',
        animationUrl: ''
    };

    /* ── Helpers ─────────────────────────────────────────────────────── */

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Manifest paths are relative to the site root, but this page lives at
    // /backoffice/, so resolve them against the root explicitly.
    function assetUrl(value) {
        const clean = String(value || '').replace(/^\/+/, '');
        return clean ? '/' + clean : '';
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = Number(bytes);
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
    }

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    }

    function formatElapsed(ms) {
        if (!ms) return '0s';
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }

    function isPending(job) {
        return job.state === 'queued' || job.state === 'running';
    }

    function toast(message, isError) {
        if (state.toastTimer) clearTimeout(state.toastTimer);
        toastEl.textContent = message;
        toastEl.classList.toggle('is-error', Boolean(isError));
        toastEl.hidden = false;
        state.toastTimer = setTimeout(() => {
            toastEl.hidden = true;
        }, isError ? 9000 : 5000);
    }

    function setButtonBusy(button, busy, label) {
        if (!button) return;
        if (busy) {
            if (!button.dataset.label) button.dataset.label = button.textContent;
            button.disabled = true;
            button.textContent = label;
        } else {
            button.disabled = false;
            button.textContent = button.dataset.label || label;
            delete button.dataset.label;
        }
    }

    async function api(path, options) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            ...(options || {})
        });

        const type = response.headers.get('content-type') || '';
        const data = type.includes('application/json')
            ? await response.json().catch(() => null)
            : null;

        if (!response.ok) {
            const error = new Error((data && data.error) || `Request failed (HTTP ${response.status}).`);
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function handleApiError(error) {
        if (error && error.status === 401) {
            showLogin('Your session expired. Please sign in again.');
            return;
        }
        toast((error && error.message) || 'Something went wrong.', true);
    }

    /* ── Views ───────────────────────────────────────────────────────── */

    function stopPolling() {
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    }

    function showLogin(message) {
        stopPolling();
        state.hadPending = false;
        dashboard.hidden = true;
        loginView.hidden = false;
        logoutBtn.hidden = true;

        loginError.hidden = !message;
        loginError.textContent = message || '';
        loginPassword.value = '';
        window.setTimeout(() => loginUsername.focus(), 50);
    }

    function showDashboard() {
        loginView.hidden = true;
        dashboard.hidden = false;
        logoutBtn.hidden = false;
        loginError.hidden = true;
        loadAll();
    }

    async function checkSession() {
        try {
            const session = await api('/api/session');
            if (session && session.authenticated) {
                showDashboard();
            } else {
                showLogin();
            }
        } catch (error) {
            showLogin('The server could not be reached. Is it running?');
        }
    }

    /* ── Data loading ────────────────────────────────────────────────── */

    async function loadAll() {
        try {
            const [targetsData, jobsData] = await Promise.all([
                api('/api/targets'),
                api('/api/jobs')
            ]);
            state.targets = (targetsData && targetsData.targets) || [];
            state.jobs = (jobsData && jobsData.jobs) || [];
            renderTargets();
            renderJobs();
            schedulePoll();
        } catch (error) {
            handleApiError(error);
        }
    }

    async function loadTargetsOnly() {
        try {
            const data = await api('/api/targets');
            state.targets = (data && data.targets) || [];
            renderTargets();
        } catch (error) {
            handleApiError(error);
        }
    }

    async function pollJobs() {
        state.timer = null;
        try {
            const data = await api('/api/jobs');
            state.jobs = (data && data.jobs) || [];
            renderJobs();

            const pending = state.jobs.some(isPending);
            if (!pending && state.hadPending) {
                state.hadPending = false;
                await loadTargetsOnly();
                toast('Generation finished. The target is ready to scan.');
            }
            if (pending) {
                state.hadPending = true;
                schedulePoll();
            }
        } catch (error) {
            if (error && error.status === 401) {
                showLogin('Your session expired. Please sign in again.');
                return;
            }
            state.timer = setTimeout(pollJobs, 4000);
        }
    }

    function schedulePoll() {
        stopPolling();
        if (!state.jobs.some(isPending)) {
            state.hadPending = false;
            return;
        }
        state.hadPending = true;
        state.timer = setTimeout(pollJobs, 1500);
    }

    /* ── Rendering ───────────────────────────────────────────────────── */

    function renderTargets() {
        const count = state.targets.length;
        targetCount.textContent = `${count} target${count === 1 ? '' : 's'}`;
        emptyTargets.hidden = count > 0;

        targetsList.innerHTML = state.targets.map((target) => {
            const dimensions = `${target.width || '?'}×${target.height || '?'} px`;
            const physical = target.widthMm && target.heightMm
                ? ` · ${Math.round(target.widthMm)}×${Math.round(target.heightMm)} mm`
                : '';
            const created = formatDate(target.createdAt);
            const badge = target.autoAnimation
                ? '<span class="badge is-generated">auto GIF</span>'
                : '<span class="badge">GIF</span>';
            const notice = target.notice
                ? `<p class="target-notice">${escapeHtml(target.notice)}</p>`
                : '';

            return `
                <article class="target-card">
                    <a class="target-thumb" href="${escapeHtml(assetUrl(target.image))}" target="_blank" rel="noopener"
                        title="Open the print image">
                        <img src="${escapeHtml(assetUrl(target.image))}" alt="${escapeHtml(target.title)}" loading="lazy" />
                    </a>
                    <div class="target-body">
                        <div class="target-title-row">
                            <h3>${escapeHtml(target.title || target.id)}</h3>
                            ${badge}
                        </div>
                        <p class="target-id">${escapeHtml(target.id)}</p>
                        <p class="target-meta">
                            ${escapeHtml(dimensions)}${escapeHtml(physical)}<br />
                            ${created ? `Added ${escapeHtml(created)}` : ''}
                        </p>
                        ${notice}
                        <div class="target-actions">
                            <a class="btn btn-ghost" href="${escapeHtml(assetUrl(target.animation))}" target="_blank"
                                rel="noopener">View GIF</a>
                            <button class="btn btn-danger" type="button"
                                data-delete="${escapeHtml(target.id)}">Delete</button>
                        </div>
                    </div>
                </article>
            `;
        }).join('');
    }

    function renderJobs() {
        const pending = state.jobs.filter(isPending);
        const shown = state.jobs.slice(0, 8);

        jobsBadge.textContent = pending.length
            ? `${pending.length} running`
            : 'Idle';
        jobsBadge.className = 'count-chip' + (pending.length ? ' is-busy' : ' is-idle');

        if (!shown.length) {
            jobsList.innerHTML = '<p class="empty">Nothing is generating right now.</p>';
            return;
        }

        jobsList.innerHTML = shown.map((job) => {
            const stateClass = job.state === 'error'
                ? 'is-error'
                : job.state === 'done'
                    ? 'is-done'
                    : job.state === 'running'
                        ? 'is-running'
                        : 'is-queued';

            let detail = escapeHtml(job.step || '');
            if (job.state === 'running') {
                detail = `<span class="spinner" aria-hidden="true"></span>${detail} · ${formatElapsed(job.elapsedMs)}`;
            } else if (job.state === 'done') {
                const timing = job.elapsedMs ? ` · took ${formatElapsed(job.elapsedMs)}` : '';
                detail = `Ready to scan${escapeHtml(timing)}`;
            } else if (job.state === 'queued') {
                detail = 'Waiting for the current job…';
            }

            const error = job.state === 'error' && job.error
                ? `<p class="job-error">${escapeHtml(job.error)}</p>`
                : '';

            return `
                <div class="job">
                    <div class="job-top">
                        <span class="job-title">${escapeHtml(job.title || job.targetId)}</span>
                        <span class="job-state ${stateClass}">${escapeHtml(job.state)}</span>
                    </div>
                    <p class="job-step">${detail}</p>
                    ${error}
                </div>
            `;
        }).join('');
    }

    /* ── Actions ─────────────────────────────────────────────────────── */

    async function deleteTarget(id) {
        const target = state.targets.find((entry) => entry.id === id);
        if (!target) return;

        const label = target.title || target.id;
        if (!window.confirm(`Delete “${label}”?\n\nThis removes its image, animation, contour map and NFT marker files.`)) {
            return;
        }

        const button = targetsList.querySelector(`[data-delete="${CSS.escape(id)}"]`);
        if (button) {
            button.disabled = true;
            button.textContent = 'Deleting…';
        }

        try {
            await api(`/api/targets/${encodeURIComponent(id)}`, { method: 'DELETE' });
            toast(`“${label}” deleted.`);
            await loadTargetsOnly();
        } catch (error) {
            if (button) {
                button.disabled = false;
                button.textContent = 'Delete';
            }
            handleApiError(error);
        }
    }

    function resetAddForm() {
        addForm.reset();
        addError.hidden = true;
        imageName.textContent = 'Choose an image…';
        animationName.textContent = 'Choose a GIF…';
        imagePreview.hidden = true;
        animationPreview.hidden = true;
        imagePreview.removeAttribute('src');
        animationPreview.removeAttribute('src');

        if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
        if (state.animationUrl) URL.revokeObjectURL(state.animationUrl);
        state.imageUrl = '';
        state.animationUrl = '';
    }

    function previewFile(file, preview, nameEl, urlKey) {
        if (state[urlKey]) URL.revokeObjectURL(state[urlKey]);
        state[urlKey] = '';

        if (!file) {
            preview.hidden = true;
            preview.removeAttribute('src');
            return;
        }

        state[urlKey] = URL.createObjectURL(file);
        preview.src = state[urlKey];
        preview.hidden = false;
        nameEl.textContent = `${file.name} · ${formatBytes(file.size)}`;
    }

    /* ── Events ──────────────────────────────────────────────────────── */

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        loginError.hidden = true;
        setButtonBusy(loginSubmit, true, 'Signing in…');

        try {
            await api('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: loginUsername.value,
                    password: loginPassword.value
                })
            });
            loginForm.reset();
            showDashboard();
        } catch (error) {
            loginError.hidden = false;
            loginError.textContent = error.message;
        } finally {
            setButtonBusy(loginSubmit, false, 'Enter backoffice');
        }
    });

    logoutBtn.addEventListener('click', async () => {
        logoutBtn.disabled = true;
        try {
            await api('/api/logout', { method: 'POST' });
        } catch (error) {
            /* the local cookie is cleared on the next login anyway */
        }
        logoutBtn.disabled = false;
        showLogin();
    });

    imageInput.addEventListener('change', () => {
        const file = imageInput.files && imageInput.files[0];
        previewFile(file, imagePreview, imageName, 'imageUrl');

        if (file && !titleInput.value.trim()) {
            titleInput.value = file.name
                .replace(/\.[^.]+$/, '')
                .replace(/[_-]+/g, ' ')
                .slice(0, 80);
        }
    });

    animationInput.addEventListener('change', () => {
        const file = animationInput.files && animationInput.files[0];
        previewFile(file, animationPreview, animationName, 'animationUrl');
    });

    addForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        addError.hidden = true;

        const image = imageInput.files && imageInput.files[0];
        if (!image) {
            addError.hidden = false;
            addError.textContent = 'Choose the print image first.';
            imageInput.focus();
            return;
        }

        const animation = animationInput.files && animationInput.files[0];
        const body = new FormData();
        body.append('image', image);
        if (animation) body.append('animation', animation);
        body.append('title', titleInput.value.trim());

        setButtonBusy(addSubmit, true, 'Uploading…');

        try {
            const response = await api('/api/targets', { method: 'POST', body });
            const job = response.job;
            const target = response.target;

            toast(`“${target.title}” queued. The marker is generating now.`);
            resetAddForm();

            if (job) {
                state.jobs = [job, ...state.jobs.filter((entry) => entry.id !== job.id)];
                renderJobs();
                schedulePoll();
            } else {
                await loadAll();
            }
        } catch (error) {
            if (error && error.status === 401) {
                showLogin('Your session expired. Please sign in again.');
            } else {
                addError.hidden = false;
                addError.textContent = error.message;
            }
        } finally {
            setButtonBusy(addSubmit, false, 'Add target');
        }
    });

    targetsList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-delete]');
        if (button) {
            deleteTarget(button.getAttribute('data-delete'));
        }
    });

    refreshBtn.addEventListener('click', () => {
        loadAll();
        toast('Library refreshed.');
    });

    window.addEventListener('beforeunload', () => {
        if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
        if (state.animationUrl) URL.revokeObjectURL(state.animationUrl);
    });

    checkSession();
})();
