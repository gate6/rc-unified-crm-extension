function getContactAdditionalInfo(contact){
    if(contact && contact.relatedDeals)
    {
        return {
            label: 'Sync to deal',
            value: relatedDeals
        }
    }

    return null;
}

function getIncomingCallContactInfo(contactInfo) {
    return {
        id: contactInfo.id,
        company: contactInfo.organization
    }
}

function openContactPage(hostname, incomingCallContactInfo){
    window.open(`https://${hostname}/person/${incomingCallContactInfo.id}`);
}

exports.getContactAdditionalInfo = getContactAdditionalInfo;
exports.getIncomingCallContactInfo = getIncomingCallContactInfo;
exports.openContactPage = openContactPage;