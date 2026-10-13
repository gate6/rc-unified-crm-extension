// Seat enforcement in the shared license helper must ignore users removed in the admin panel.
// Removal is a soft delete (customer.isDeleted = true): the row stays, but no longer holds a seat.

export {};

function loadLicense(userId) {
    jest.resetModules();
    jest.doMock('@app-connect/core/models/userModel', () => ({
        UserModel: { findByPk: jest.fn().mockResolvedValue({ id: userId, rcAccountId: 'rc-1', hostname: 'acme.example.com', platform: 'monday' }) }
    }));
    return require('../../src/connectors/shared/license');
}

// Customer rows are filtered by the `where` clause the helper sends, like the database would.
function fakeModels({ maxAllowedUsers, customers }) {
    const findAll = jest.fn().mockImplementation(async ({ where }) =>
        customers.filter(row => Object.entries(where).every(([key, value]) => (row[key] ?? false) === value))
    );
    return {
        models: {
            companies: { findOne: jest.fn().mockResolvedValue({ id: 7, status: true, maxAllowedUsers }) },
            customer: { findAll }
        },
        findAll
    };
}

describe('license seats and removed users', () => {
    afterEach(() => {
        jest.dontMock('@app-connect/core/models/userModel');
    });

    test('a removed user does not hold a seat, so a new user fits under the cap', async () => {
        const license = loadLicense('new-user');
        const { models, findAll } = fakeModels({
            maxAllowedUsers: 2,
            customers: [
                { companyId: 7, sysId: 'user-a', isDeleted: false },
                { companyId: 7, sysId: 'user-b', isDeleted: true }
            ]
        });

        const status = await license.getLicenseStatus({ models, userId: 'new-user' });

        expect(status.isLicenseValid).toBe(true);
        expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 7, isDeleted: false } }));
    });

    test('a company at its cap with only active users still blocks a new user', async () => {
        const license = loadLicense('new-user');
        const { models } = fakeModels({
            maxAllowedUsers: 2,
            customers: [
                { companyId: 7, sysId: 'user-a', isDeleted: false },
                { companyId: 7, sysId: 'user-b', isDeleted: false }
            ]
        });

        const status = await license.getLicenseStatus({ models, userId: 'new-user' });

        expect(status.isLicenseValid).toBe(false);
        expect(status.licenseStatusDescription).toContain('seat limit reached');
    });

    test('removed users ahead in the queue do not push an active user past the cap', async () => {
        const license = loadLicense('user-c');
        const { models } = fakeModels({
            maxAllowedUsers: 1,
            customers: [
                { companyId: 7, sysId: 'user-a', isDeleted: true },
                { companyId: 7, sysId: 'user-c', isDeleted: false }
            ]
        });

        const status = await license.getLicenseStatus({ models, userId: 'user-c' });

        expect(status.isLicenseValid).toBe(true);
    });
});
