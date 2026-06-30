// ─── RB Esports Auth Module (Email Link / Passwordless) ───
(function() {
    const AUTH_STORAGE_KEY = 'rbAuthUser';
    const EMAIL_STORAGE_KEY = 'emailForSignIn';

    let initialized = false;
    let auth = null;
    let userDb = null;
    let currentUser = null;
    const listeners = [];

    window.rbAuth = {
        init,
        getAuth,
        getUserDb,
        getCurrentUser: () => currentUser,
        isLoggedIn: () => !!currentUser,
        onAuthStateChanged: cb => { listeners.push(cb); if (currentUser !== undefined) cb(currentUser); },
        sendEmailLink,
        handleEmailLinkSignIn,
        signOut,
        completeProfile,
        getUserProfile,
        getUserId: () => currentUser?.uid || null,
        getFirebaseRef,
        migrateLocalToFirebase,
        showAuthUI,
        hideAuthUI
    };

    function getFirebaseConfig() {
        if (typeof PUBLIC_FIREBASE_CONFIG !== 'undefined' && PUBLIC_FIREBASE_CONFIG) return PUBLIC_FIREBASE_CONFIG;
        try {
            const raw = localStorage.getItem('rbeFirebaseConfig');
            if (raw) return JSON.parse(raw);
        } catch(e) {}
        return null;
    }

    function init() {
        if (initialized) return true;
        const cfg = getFirebaseConfig();
        if (!cfg || !cfg.apiKey || !cfg.projectId) return false;
        try {
            const fbApp = firebase.initializeApp(cfg, 'rbAuthApp');
            auth = firebase.auth(fbApp);
            userDb = firebase.database(fbApp);

            const cached = localStorage.getItem(AUTH_STORAGE_KEY);
            if (cached) {
                try { currentUser = JSON.parse(cached); } catch(e) { currentUser = null; }
            }

            auth.onAuthStateChanged(user => {
                currentUser = user;
                if (user) {
                    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ uid: user.uid, email: user.email, displayName: user.displayName }));
                } else {
                    localStorage.removeItem(AUTH_STORAGE_KEY);
                }
                listeners.forEach(cb => { try { cb(user); } catch(e) {} });
            });
            initialized = true;
            return true;
        } catch(e) {
            console.warn('Auth init failed:', e);
            return false;
        }
    }

    function getAuth() { return auth; }
    function getUserDb() { return userDb; }

    function getFirebaseRef(path) {
        if (!userDb || !currentUser) return null;
        return userDb.ref('users/' + currentUser.uid + '/' + path);
    }

    // ─── Email Link (Passwordless) Auth ─────────────────
    function sendEmailLink(email) {
        if (!auth) return Promise.reject(new Error('Firebase Auth not initialized'));
        // Use current page URL (without query/hash) as continue URL
        const continueUrl = window.location.origin + window.location.pathname;
        const actionCodeSettings = {
            url: continueUrl,
            handleCodeInApp: true
        };
        return auth.sendSignInLinkToEmail(email, actionCodeSettings)
            .then(() => {
                localStorage.setItem(EMAIL_STORAGE_KEY, email);
                sessionStorage.setItem(EMAIL_STORAGE_KEY, email); // backup
            });
    }

    // Call on every page load; resolves with user if returning from email link
    function handleEmailLinkSignIn() {
        return new Promise((resolve, reject) => {
            if (!auth) return resolve(null);
            if (!auth.isSignInWithEmailLink(window.location.href)) return resolve(null);
            // Try sessionStorage first (more per-tab), then localStorage
            let email = sessionStorage.getItem(EMAIL_STORAGE_KEY) || localStorage.getItem(EMAIL_STORAGE_KEY);
            if (!email) {
                // Ask user to re-enter email (cross-device or cleared storage)
                email = prompt('Enter the email you used to request the sign-in link:');
                if (!email) {
                    reject(new Error('Email required to complete sign-in.'));
                    return;
                }
            }
            auth.signInWithEmailLink(email, window.location.href)
                .then(result => {
                    localStorage.removeItem(EMAIL_STORAGE_KEY);
                    sessionStorage.removeItem(EMAIL_STORAGE_KEY);
                    // Clean URL params without page reload
                    if (window.history && window.history.replaceState) {
                        window.history.replaceState({}, document.title, window.location.pathname);
                    }
                    resolve(result.user);
                })
                .catch(err => {
                    localStorage.removeItem(EMAIL_STORAGE_KEY);
                    sessionStorage.removeItem(EMAIL_STORAGE_KEY);
                    reject(err);
                });
        });
    }

    function completeProfile(name, phone) {
        return new Promise((resolve, reject) => {
            if (!currentUser) return reject(new Error('No user logged in'));
            if (!userDb) return reject(new Error('Database not initialized'));

            const profileData = {
                name: name.trim(),
                email: currentUser.email || '',
                phone: phone.trim(),
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };

            if (name.trim()) {
                currentUser.updateProfile({ displayName: name.trim() }).catch(() => {});
            }

            userDb.ref('users/' + currentUser.uid + '/profile').set(profileData)
                .then(() => userDb.ref('users/' + currentUser.uid + '/tournaments').set({}))
                .then(() => resolve(profileData))
                .catch(err => reject(err));
        });
    }

    function getUserProfile() {
        return new Promise((resolve, reject) => {
            if (!currentUser || !userDb) return resolve(null);
            userDb.ref('users/' + currentUser.uid + '/profile').once('value')
                .then(snap => resolve(snap.val()))
                .catch(() => resolve(null));
        });
    }

    function signOut() {
        if (!auth) return Promise.resolve();
        return auth.signOut().then(() => {
            currentUser = null;
            localStorage.removeItem(AUTH_STORAGE_KEY);
        });
    }

    function migrateLocalToFirebase() {
        return new Promise((resolve, reject) => {
            if (!currentUser || !userDb) return reject(new Error('Not logged in'));
            try {
                const localData = localStorage.getItem('rbeTournaments');
                if (localData) {
                    const tournaments = JSON.parse(localData);
                    if (Array.isArray(tournaments) && tournaments.length) {
                        const data = {};
                        tournaments.forEach((t, i) => { data[String(i)] = t; });
                        userDb.ref('users/' + currentUser.uid + '/tournaments').set(data)
                            .then(() => resolve(true))
                            .catch(err => reject(err));
                        return;
                    }
                }
                resolve(false);
            } catch(e) { reject(e); }
        });
    }

    // ─── Auth UI helpers ────────────────────────────
    function showAuthUI(mode) {
        const overlay = document.getElementById('authOverlay');
        const panel = document.getElementById('authPanel');
        if (overlay && panel) {
            overlay.style.display = 'flex';
            panel.style.display = 'block';
            showAuthStep('Email');
            // Clear email input on fresh open
            const el = document.getElementById('authEmail');
            if (el && mode !== 'pending') el.value = '';
        }
    }

    function hideAuthUI() {
        const overlay = document.getElementById('authOverlay');
        const panel = document.getElementById('authPanel');
        if (overlay) overlay.style.display = 'none';
        if (panel) panel.style.display = 'none';
    }

    window.showAuthStep = function(step) {
        document.querySelectorAll('.auth-step').forEach(el => el.style.display = 'none');
        const target = document.getElementById('authStep' + step.charAt(0).toUpperCase() + step.slice(1));
        if (target) target.style.display = 'block';
    };

    // Auto-initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init());
    } else {
        init();
    }
})();
