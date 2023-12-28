import manifest from '../../public/manifest.json';
import config from '../config.json';
import mixpanel from 'mixpanel-browser';

mixpanel.init(config.mixpanelToken);

const appName = 'RingCentral CRM Extension';
const version = manifest.version;

exports.reset = function reset() {
    mixpanel.reset();
}

exports.identify = function identify({ platformName, rcAccountId, extensionId }) {
    mixpanel.identify(extensionId);
    mixpanel.people.set({
        platformName,
        rcAccountId,
        version
    });
}

// May not need this
// exports.group = function group({ platformName, rcAccountId }) {
//     mixpanel.set_group('organization', rcAccountId);
//     mixpanel.get_group('organization', rcAccountId).set({ platformName });
// }

function track(event, properties = {}) {
    mixpanel.track(event, { appName, version, ...properties });
}

exports.trackPage = function page(name, properties = {}) {
    try {
        const pathSegments = name.split('/');
        const rootPath = `/${pathSegments[1]}`;
        const childPath = name.split(rootPath)[1];
        mixpanel.track_pageview(
            {
                appName,
                version,
                path: window.location.pathname,
                childPath,
                search: window.location.search,
                url: window.location.href,
                ...properties
            },
            {
                event_name: `Viewed ${rootPath}`
            });
    }
    catch (e) {
        console.log(e)
    }
}


exports.trackFirstTimeSetup = function trackFirstTimeSetup() {
    track('First time setup', {
        appName
    });
}
exports.trackRcLogin = function trackRcLogin({ rcAccountId }) {
    track('Login with RingCentral account', {
        appName,
        rcAccountId
    });
}
exports.trackRcLogout = function trackRcLogout({ rcAccountId }) {
    track('Logout with RingCentral account', {
        appName,
        rcAccountId
    });
}
exports.trackCrmLogin = function trackCrmLogin({ rcAccountId }) {
    track('Login with CRM account', {
        appName,
        rcAccountId
    });
}
exports.trackCrmLogout = function trackCrmLogout({ rcAccountId }) {
    track('Logout with CRM account', {
        appName,
        rcAccountId
    });
}
exports.trackPlacedCall = function trackPlacedCall({ rcAccountId }) {
    track('A new call placed', {
        appName,
        rcAccountId
    });
}
exports.trackAnsweredCall = function trackAnsweredCall({ rcAccountId }) {
    track('A new call answered', {
        appName,
        rcAccountId
    });
}
exports.trackConnectedCall = function trackConnectedCall({ rcAccountId }) {
    track('A new call connected', {
        appName,
        rcAccountId
    });
}
exports.trackCallEnd = function trackCallEnd({ rcAccountId, durationInSeconds }) {
    track('A call is ended', {
        durationInSeconds,
        appName,
        rcAccountId
    });
}
exports.trackSentSMS = function trackSentSMS({ rcAccountId }) {
    track('A new SMS sent', {
        appName,
        rcAccountId
    });
}
exports.trackSyncCallLog = function trackSyncCallLog({ rcAccountId, hasNote }) {
    track('Sync call log', {
        hasNote,
        appName,
        rcAccountId
    })
}
exports.trackSyncMessageLog = function trackSyncMessageLog({ rcAccountId }) {
    track('Sync message log', {
        appName,
        rcAccountId
    })
}
exports.trackEditSettings = function trackEditSettings({ rcAccountId, changedItem, status }) {
    track('Edit settings', {
        changedItem,
        status,
        appName,
        rcAccountId
    })
}

exports.trackCreateMeeting = function trackCreateMeeting({ rcAccountId }) {
    track('Create meeting', {
        appName,
        rcAccountId
    })
}
exports.trackOpenFeedback = function trackOpenFeedback({ rcAccountId }) {
    track('Open feedback', {
        appName,
        rcAccountId
    })
}
exports.trackSubmitFeedback = function trackSubmitFeedback({ rcAccountId }) {
    track('Submit feedback', {
        appName,
        rcAccountId
    })
}