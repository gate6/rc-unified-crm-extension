// @ts-nocheck
// Pure helpers for the "write the interaction's number back into the CRM contact" flow shared by
// the connectors. No caching and no DB access — core owns the phone->contact cache and keeps it
// truthful itself (it re-runs findContact on a cache miss and drops/updates stale rows on a force
// refresh), so the connectors only need to (a) know which number the interaction came in on and
// (b) decide whether it's new to the picked contact.

// The number that was actually called/messaged (the non-agent side), taken from the RC payload
// rather than from contactInfo — which core sets to the CALL's number, not the contact's stored
// number. This is the value written back into the CRM contact so future phone lookups resolve.
//
// Pass exactly one of callLog / message.
function resolveCounterpartyNumber({ callLog, message } = {}) {
    if (callLog) {
        return callLog.direction === 'Inbound'
            ? callLog.from?.phoneNumber
            : callLog.to?.phoneNumber;
    }
    if (message) {
        // message.to is an array (a message can have several recipients); the counterparty on
        // an outbound message is the first recipient.
        return message.direction === 'Inbound'
            ? message.from?.phoneNumber
            : message.to?.[0]?.phoneNumber;
    }
    return undefined;
}

// True when `receivedNumber` is a real number the contact does not already carry, i.e. the
// write-back should fire. Compares on digits only so formatting differences don't matter.
// `knownNumbers` may be a single value or an array.
function isNewNumberForContact(receivedNumber, knownNumbers) {
    const digits = (v) => String(v ?? '').replace(/\D/g, '');
    const received = digits(receivedNumber);
    if (!received) {
        return false;
    }
    const known = (Array.isArray(knownNumbers) ? knownNumbers : [knownNumbers])
        .map(digits)
        .filter(Boolean);
    // Treat as new unless an existing number matches (suffix match tolerates country-code and
    // significant-digit differences between the CRM's stored value and RC's E.164 number).
    return !known.some((k) => k === received || k.endsWith(received) || received.endsWith(k));
}

module.exports = {
    resolveCounterpartyNumber,
    isNewNumberForContact
};

export {};
