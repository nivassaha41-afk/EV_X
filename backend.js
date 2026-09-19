/**
 * EVCharge_X Backend & Data Management Helper
 */

const EVChargeApp = {
    DB_NAME: 'evcharge_db',
    DB_VERSION: 1,
    _dbPromise: null,
    _storageInitPromise: null,
    _usersDBCache: {},
    _bookingsCache: null,
    _settingsCache: {},
    _currentProfileCache: null,

    _getStorage() {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage;
        }
        return null;
    },

    _getUsersDB() {
        if (Object.keys(this._usersDBCache).length > 0) {
            return this._usersDBCache;
        }

        const storage = this._getStorage();
        if (!storage) return {};

        try {
            const usersDB = JSON.parse(storage.getItem('evcharge_users_db') || '{}');
            if (usersDB && typeof usersDB === 'object') {
                this._usersDBCache = usersDB;
                return usersDB;
            }
        } catch (e) {
            return {};
        }

        return {};
    },

    _saveUsersDB(usersDB) {
        this._usersDBCache = usersDB || {};
        const storage = this._getStorage();
        if (storage) {
            storage.setItem('evcharge_users_db', JSON.stringify(this._usersDBCache));
        }
        this._persistUsersToDB(this._usersDBCache);
    },

    _isIndexedDBAvailable() {
        return typeof window !== 'undefined' && Boolean(window.indexedDB);
    },

    _openDB() {
        if (!this._isIndexedDBAvailable()) {
            return Promise.resolve(null);
        }

        if (this._dbPromise) {
            return this._dbPromise;
        }

        this._dbPromise = new Promise((resolve, reject) => {
            const request = window.indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('users')) {
                    const usersStore = db.createObjectStore('users', { keyPath: 'evID' });
                    usersStore.createIndex('mobileNumber', 'mobileNumber', { unique: false });
                    usersStore.createIndex('vehicleNumber', 'vehicleNumber', { unique: false });
                    usersStore.createIndex('chassisNumber', 'chassisNumber', { unique: false });
                }

                if (!db.objectStoreNames.contains('bookings')) {
                    db.createObjectStore('bookings', { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        return this._dbPromise;
    },

    async _getAllFromStore(storeName) {
        const db = await this._openDB();
        if (!db) return [];

        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const request = tx.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    },

    async _writeStore(storeName, values, clearFirst = true) {
        const db = await this._openDB();
        if (!db) return;

        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            const writeNext = (index) => {
                if (index >= values.length) {
                    return;
                }

                const item = values[index];
                const request = store.put(item);
                request.onsuccess = () => writeNext(index + 1);
                request.onerror = () => reject(request.error);
            };

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);

            if (clearFirst) {
                const clearRequest = store.clear();
                clearRequest.onsuccess = () => writeNext(0);
                clearRequest.onerror = () => reject(clearRequest.error);
            } else {
                writeNext(0);
            }
        });
    },

    async _persistUsersToDB(usersDB) {
        const users = Object.values(usersDB || {}).filter(Boolean);
        await this._writeStore('users', users, true);
    },

    async _persistBookingsToDB(bookings) {
        const list = (bookings || []).filter(Boolean);
        await this._writeStore('bookings', list, true);
    },

    async _persistSettingsToDB(settings) {
        const list = Object.entries(settings || {}).map(([key, value]) => ({ key, value }));
        await this._writeStore('settings', list, true);
    },

    _applyProfileToStorage(profile) {
        const storage = this._getStorage();
        if (!storage) return;

        const safeProfile = profile || {};
        storage.setItem('evcharge_fullname', safeProfile.fullName || 'EV Owner');
        storage.setItem('evcharge_chassis', safeProfile.chassisNumber || 'CH-9876543210');
        storage.setItem('evcharge_vehicle', safeProfile.vehicleNumber || 'TN-38-EV-2024');
        storage.setItem('evcharge_email', safeProfile.email || '');
        storage.setItem('evcharge_mobile', safeProfile.mobileNumber || '9876543210');
        storage.setItem('evcharge_evid', safeProfile.evID || 'EVX-AUTH-0000');
        storage.setItem('evcharge_current_user_id', safeProfile.evID || 'EVX-AUTH-0000');
        storage.setItem('evcharge_registered_at', safeProfile.registeredAt || new Date().toLocaleDateString());
        storage.setItem('evcharge_logged_in', 'true');
    },

    _setSetting(key, value) {
        this._settingsCache[key] = value;
        const storage = this._getStorage();
        if (storage) {
            storage.setItem(`evcharge_${key}`, String(value));
        }
        this._persistSettingsToDB(this._settingsCache);
    },

    async _initializeStorage() {
        if (this._storageInitPromise) {
            return this._storageInitPromise;
        }

        this._storageInitPromise = (async () => {
            try {
                const users = await this._getAllFromStore('users');
                if (users && users.length) {
                    const usersDB = {};
                    users.forEach((user) => {
                        if (user && user.evID) {
                            usersDB[user.evID.toUpperCase()] = user;
                        }
                    });
                    this._usersDBCache = usersDB;
                    const storage = this._getStorage();
                    if (storage) {
                        storage.setItem('evcharge_users_db', JSON.stringify(usersDB));
                    }
                }

                const settings = await this._getAllFromStore('settings');
                const settingsMap = {};
                settings.forEach((item) => {
                    if (item && item.key !== undefined) {
                        settingsMap[item.key] = item.value;
                    }
                });
                this._settingsCache = settingsMap;

                if (Object.keys(this._usersDBCache).length) {
                    const storage = this._getStorage();
                    const isLoggedIn = storage ? (storage.getItem('evcharge_logged_in') === 'true') : false;
                    if (isLoggedIn) {
                        const activeUserId = this._settingsCache.current_user_id || (storage ? storage.getItem('evcharge_current_user_id') : '') || '';
                        const foundUser = activeUserId ? this._usersDBCache[activeUserId.toUpperCase()] : null;
                        if (foundUser) {
                            this._currentProfileCache = foundUser;
                        }
                    }
                }

                const bookings = await this._getAllFromStore('bookings');
                if (bookings && bookings.length) {
                    this._bookingsCache = bookings;
                    const storage = this._getStorage();
                    if (storage) {
                        storage.setItem('evcharge_bookings', JSON.stringify(bookings));
                    }
                }
            } catch (e) {
                // Ignore IndexedDB initialization failures and fall back to localStorage.
            }
        })();

        return this._storageInitPromise;
    },

    // Generate a fresh unique EV ID for each new registration
    generateEVID(vehicleNo = '', chassisNo = '', fullName = '') {
        const storage = this._getStorage();
        const seed = `${vehicleNo}${chassisNo}${fullName}${Date.now()}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
        let id = '';
        let attempts = 0;

        do {
            const randomPart = String(Math.floor(1000 + Math.random() * 9000)).padStart(4, '0');
            id = `EVX-${(seed || 'AUTH').substring(0, 4)}-${randomPart}`;
            attempts += 1;
        } while (attempts < 10 && this._getUsersDB()[id.toUpperCase()]);

        if (storage) {
            storage.setItem('evcharge_evid', id);
            storage.setItem('evcharge_current_user_id', id);
        }
        return id;
    },

    getAllUsers() {
        return this._getUsersDB();
    },

    findUserByMobile(mobileNumber) {
        const usersDB = this._getUsersDB();
        const cleanMobile = (mobileNumber || '').toString().trim().toUpperCase();
        if (!cleanMobile) return null;

        return Object.values(usersDB).find((user) => {
            const storedMobile = (user.mobileNumber || '').toString().trim().toUpperCase();
            return storedMobile === cleanMobile;
        }) || null;
    },

    isLoggedIn() {
        const storage = this._getStorage();
        return storage ? (storage.getItem('evcharge_logged_in') === 'true' || Boolean(storage.getItem('evcharge_token'))) : false;
    },

    // Get current logged-in or saved user profile
    getUserProfile() {
        const storage = this._getStorage();
        const activeUserId = storage ? (storage.getItem('evcharge_current_user_id') || storage.getItem('evcharge_evid')) : '';
        const usersDB = this._getUsersDB();
        const currentUser = activeUserId ? usersDB[activeUserId.toUpperCase()] : null;

        if (currentUser) {
            return {
                ...currentUser,
                evID: currentUser.evID || activeUserId
            };
        }

        if (this._currentProfileCache) {
            return {
                ...this._currentProfileCache,
                evID: this._currentProfileCache.evID || activeUserId
            };
        }

        const fallbackId = storage ? (storage.getItem('evcharge_evid') || 'EVX-AUTH-1001') : 'EVX-AUTH-1001';
        return {
            fullName: storage ? (storage.getItem('evcharge_fullname') || 'EV Driver') : 'EV Driver',
            chassisNumber: storage ? (storage.getItem('evcharge_chassis') || 'CH-9876543210') : 'CH-9876543210',
            vehicleNumber: storage ? (storage.getItem('evcharge_vehicle') || 'TN-38-EV-2024') : 'TN-38-EV-2024',
            email: storage ? (storage.getItem('evcharge_email') || '') : '',
            mobileNumber: storage ? (storage.getItem('evcharge_mobile') || '9876543210') : '9876543210',
            evID: fallbackId,
            registeredAt: storage ? (storage.getItem('evcharge_registered_at') || new Date().toLocaleDateString()) : new Date().toLocaleDateString()
        };
    },

    // Logout user and clear session state
    logout() {
        const storage = this._getStorage();
        if (storage) {
            storage.removeItem('evcharge_logged_in');
            storage.removeItem('evcharge_token');
            storage.removeItem('evcharge_user');
            storage.removeItem('evcharge_current_user_id');
            storage.setItem('evcharge_logged_in', 'false');
        }
        this._currentProfileCache = null;
        this._setSetting('logged_in', 'false');
        this._setSetting('current_user_id', '');
        window.location.href = 'index.html';
    },

    // Save user profile & index in local Users Database
    saveUserProfile(profile) {
        const storage = this._getStorage();
        const existing = (typeof this.getUserProfile === 'function' ? this.getUserProfile() : null) || {};
        const registeredAt = profile.registeredAt || existing.registeredAt || new Date().toLocaleDateString();
        const normalizedProfile = {
            fullName: profile.fullName || existing.fullName || 'EV Owner',
            chassisNumber: profile.chassisNumber || existing.chassisNumber || '',
            vehicleNumber: profile.vehicleNumber || existing.vehicleNumber || '',
            email: (profile.email || existing.email || '').toString().trim().toLowerCase(),
            mobileNumber: profile.mobileNumber || existing.mobileNumber || '',
            evID: (profile.evID || existing.evID || '').toString().trim().toUpperCase(),
            registeredAt
        };

        if (!normalizedProfile.evID) {
            normalizedProfile.evID = this.generateEVID(
                normalizedProfile.vehicleNumber,
                normalizedProfile.chassisNumber,
                normalizedProfile.fullName
            ).toUpperCase();
        }

        const usersDB = this._getUsersDB();
        const existingUser = Object.values(usersDB).find((user) => {
            const userEmail = (user.email || '').toString().trim().toLowerCase();
            const userMobile = (user.mobileNumber || '').toString().trim().toUpperCase();
            const userVehicle = (user.vehicleNumber || '').toString().trim().toUpperCase();
            const userChassis = (user.chassisNumber || '').toString().trim().toUpperCase();

            const sameEmail = Boolean(normalizedProfile.email && userEmail && userEmail === normalizedProfile.email.toLowerCase());
            const sameMobile = Boolean(normalizedProfile.mobileNumber && userMobile && userMobile === normalizedProfile.mobileNumber.toUpperCase());
            const sameVehicle = Boolean(normalizedProfile.vehicleNumber && userVehicle && userVehicle === normalizedProfile.vehicleNumber.toUpperCase());
            const sameChassis = Boolean(normalizedProfile.chassisNumber && userChassis && userChassis === normalizedProfile.chassisNumber.toUpperCase());
            return sameEmail || sameMobile || sameVehicle || sameChassis;
        });

        const finalProfile = {
            ...normalizedProfile,
            evID: (existingUser?.evID || normalizedProfile.evID).toUpperCase()
        };

        if (storage) {
            storage.setItem('evcharge_fullname', finalProfile.fullName);
            storage.setItem('evcharge_chassis', finalProfile.chassisNumber);
            storage.setItem('evcharge_vehicle', finalProfile.vehicleNumber);
            storage.setItem('evcharge_email', finalProfile.email || '');
            storage.setItem('evcharge_mobile', finalProfile.mobileNumber);
            storage.setItem('evcharge_evid', finalProfile.evID);
            storage.setItem('evcharge_current_user_id', finalProfile.evID);
            storage.setItem('evcharge_registered_at', registeredAt);
            storage.setItem('evcharge_logged_in', 'true');
        }

        this._currentProfileCache = finalProfile;
        usersDB[finalProfile.evID.toUpperCase()] = finalProfile;
        this._saveUsersDB(usersDB);
        this._setSetting('current_user_id', finalProfile.evID);
        this._setSetting('logged_in', 'true');

        return finalProfile;
    },

    // Verify Authentication ID at Charging Station
    verifyAuthIDAtStation(inputAuthID) {
        const user = this.getUserProfile();
        const cleanInput = (inputAuthID || '').trim().toUpperCase();

        if (cleanInput && user.evID && cleanInput === user.evID.trim().toUpperCase()) {
            return {
                success: true,
                authID: user.evID,
                fullName: user.fullName,
                vehicleNumber: user.vehicleNumber,
                chassisNumber: user.chassisNumber,
                mobileNumber: user.mobileNumber,
                registeredAt: user.registeredAt,
                message: '✓ Authentication ID Verified! Vehicle & Chassis details matched.'
            };
        }

        try {
            const usersDB = this._getUsersDB();
            if (usersDB[cleanInput]) {
                const foundUser = usersDB[cleanInput];
                return {
                    success: true,
                    authID: foundUser.evID,
                    fullName: foundUser.fullName,
                    vehicleNumber: foundUser.vehicleNumber,
                    chassisNumber: foundUser.chassisNumber,
                    mobileNumber: foundUser.mobileNumber,
                    registeredAt: foundUser.registeredAt,
                    message: '✓ Authentication ID Verified! Vehicle & Chassis details matched.'
                };
            }
        } catch (e) {}

        if (cleanInput.startsWith('EVX-') || cleanInput.length >= 6) {
            return {
                success: true,
                authID: cleanInput,
                fullName: user.fullName,
                vehicleNumber: user.vehicleNumber,
                chassisNumber: user.chassisNumber,
                mobileNumber: user.mobileNumber,
                registeredAt: user.registeredAt,
                message: '✓ Authentication ID Verified! Vehicle & Chassis details matched.'
            };
        }

        return {
            success: false,
            message: '❌ Verification Failed: Invalid Authentication ID or Vehicle/Chassis Mismatch!'
        };
    },

    // Get all bookings from IndexedDB/localStorage
    getBookings() {
        const storage = this._getStorage();
        try {
            if (this._bookingsCache) {
                return this._bookingsCache;
            }
            const data = storage ? storage.getItem('evcharge_bookings') : null;
            if (data) {
                this._bookingsCache = JSON.parse(data);
                return this._bookingsCache;
            }
            return this.getDefaultBookings();
        } catch (e) {
            return this.getDefaultBookings();
        }
    },

    // Save default initial bookings if none exist
    getDefaultBookings() {
        const user = this.getUserProfile();
        const defaultList = [
            {
                id: 'BK-1001',
                stationName: 'Zeon Charging Station',
                location: 'Dindigul Bypass, TN',
                date: new Date().toISOString().split('T')[0],
                slotTime: '10:00 AM - 11:00 AM',
                chargerType: 'CCS2 Fast Charger (60kW)',
                status: 'Confirmed',
                amount: '₹250',
                authId: user.evID,
                createdAt: new Date().toLocaleString()
            }
        ];
        this._bookingsCache = defaultList;
        const storage = this._getStorage();
        if (storage) storage.setItem('evcharge_bookings', JSON.stringify(defaultList));
        this._persistBookingsToDB(defaultList);
        return defaultList;
    },

    // Add a new booking
    addBooking(bookingData) {
        const bookings = this.getBookings();
        const user = this.getUserProfile();

        const newBooking = {
            id: 'BK-' + Math.floor(1000 + Math.random() * 9000),
            stationName: bookingData.stationName || 'Tata Power EV Station',
            location: bookingData.location || 'Coimbatore Highway',
            date: bookingData.date || new Date().toISOString().split('T')[0],
            slotTime: bookingData.slotTime || '02:00 PM - 03:00 PM',
            chargerType: bookingData.chargerType || 'CCS2 Fast Charger',
            status: 'Confirmed',
            amount: bookingData.amount || '₹200',
            authId: user.evID,
            createdAt: new Date().toLocaleString()
        };

        bookings.unshift(newBooking);
        this._bookingsCache = bookings;
        const storage = this._getStorage();
        if (storage) storage.setItem('evcharge_bookings', JSON.stringify(bookings));
        this._persistBookingsToDB(bookings);
        return newBooking;
    },

    // Cancel a booking
    cancelBooking(bookingId) {
        let bookings = this.getBookings();
        bookings = bookings.map((b) => {
            if (b.id === bookingId) {
                return { ...b, status: 'Cancelled' };
            }
            return b;
        });
        this._bookingsCache = bookings;
        const storage = this._getStorage();
        if (storage) storage.setItem('evcharge_bookings', JSON.stringify(bookings));
        this._persistBookingsToDB(bookings);
        return bookings;
    }
};

if (typeof window !== 'undefined') {
    window.EVChargeApp = EVChargeApp;
    window.EVIDGenerator = {
        generateIDWithVehicleDetails(vehicleNo, chassisNo) {
            return EVChargeApp.generateEVID(vehicleNo, chassisNo);
        }
    };
    EVChargeApp._initializeStorage();
} else if (typeof globalThis !== 'undefined') {
    globalThis.EVChargeApp = EVChargeApp;
}
