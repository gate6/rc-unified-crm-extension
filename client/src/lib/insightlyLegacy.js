import axios from 'axios';

async function fetchAllContacts() {
    const { insightlyApiKey } = await chrome.storage.local.get({ insightlyApiKey: null });
    if (insightlyApiKey != null) {
        const authHeader = `Basic ${btoa(`${insightlyApiKey.apiKey}:`)}`;
        let allFetched = false;
        const contactList = [];
        while (!allFetched) {
            const contactResponse = await axios.get(
                `${insightlyApiKey.apiUrl}Contacts?brief=true&skip=${contactList.length}&count_total=true`,
                {
                    headers: { 'Authorization': authHeader }
                });
            contactList.push(...contactResponse.data);
            allFetched = contactResponse.headers['x-total-count'] == contactList.length;
        }
        console.log(`synced ${contactList.length} contacts from Insightly.`);
        const leadList = [];
        allFetched = false;
        while (!allFetched) {
            const leadResponse = await axios.get(
                `${insightlyApiKey.apiUrl}Leads?brief=true&skip=${leadList.length}&count_total=true`,
                {
                    headers: { 'Authorization': authHeader }
                });
            leadList.push(...leadResponse.data);
            allFetched = leadResponse.headers['x-total-count'] == leadList.length;
        }
        console.log(`synced ${leadList.length} leads from Insightly.`);
        // TODO: sync with time interval
        // TODO: add Lead
        // TODO: save log
        // TODO: auto log
        const formattedContactList = contactList.map(c => {
            let contact = {
                id: c.CONTACT_ID.toString(),
                name: `${c.FIRST_NAME} ${c.LAST_NAME}`,
                type: 'insightly',
                phoneNumbers: [],
                entityType: 'Contact'
            }
            if (c.PHONE != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE, phoneType: 'direct' })
            if (c.PHONE_HOME != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE_HOME, phoneType: 'home' })
            if (c.PHONE_MOBILE != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE_MOBILE, phoneType: 'mobile' })
            if (c.PHONE_OTHER != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE_OTHER, phoneType: 'other' })

            return contact;
        });
        const formattedLeadList = leadList.map(l => {
            let lead = {
                id: l.LEAD_ID.toString(),
                name: `${l.FIRST_NAME} ${l.LAST_NAME}`,
                type: 'insightly',
                phoneNumbers: [],
                entityType: 'Lead'
            }
            if (l.PHONE != null) lead.phoneNumbers.push({ phoneNumber: l.PHONE, phoneType: 'direct' })
            if (l.PHONE_MOBILE != null) lead.phoneNumbers.push({ phoneNumber: l.PHONE_MOBILE, phoneType: 'mobile' })

            return lead;
        });
        const insightlyContacts = formattedContactList.concat(formattedLeadList);
        await chrome.storage.local.set({ insightlyContacts });
        return insightlyContacts;
    }
    return [];
}

async function getContactByNumber({ phoneNumber }) {
    const { insightlyContacts } = await chrome.storage.local.get({ insightlyContacts: [] });
    return insightlyContacts.find(c => c.phoneNumbers.some(p => p.phoneNumber === phoneNumber));
}

exports.fetchAllContacts = fetchAllContacts;
exports.getContactByNumber = getContactByNumber;