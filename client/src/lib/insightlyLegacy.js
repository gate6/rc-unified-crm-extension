import axios from 'axios';

async function fetchAllContacts() {
    const { insightlyApiKey } = await chrome.storage.local.get({ insightlyApiKey: null });
    if (insightlyApiKey != null) {
        let allFetched = false;
        const contactList = [];
        const authHeader = `Basic ${btoa(`${insightlyApiKey.apiKey}:`)}`;
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
        // TODO: sync with time interval
        // TODO: add Lead
        // TODO: contact match
        // TODO: save log
        // TODO: auto log
        return contactList.map(c => {
            let contact = {
                id: c.CONTACT_ID.toString(),
                name: `${c.FIRST_NAME} ${c.LAST_NAME}`,
                type: 'insightly',
                phoneNumbers: []
            }
            if (c.PHONE != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE, phoneType: 'direct' })
            if (c.PHONE_HOME != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE_HOME, phoneType: 'home' })
            if (c.PHONE_MOBILE != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE_MOBILE, phoneType: 'mobile' })
            if (c.PHONE_OTHER != null) contact.phoneNumbers.push({ phoneNumber: c.PHONE_OTHER, phoneType: 'other' })
            
            return contact;
        });
    }
    return [];
}

exports.fetchAllContacts = fetchAllContacts;