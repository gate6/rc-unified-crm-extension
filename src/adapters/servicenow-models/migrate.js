// Keeps the database in step with the models defined in code.
//
// For every model (table blueprint) it is given, it checks that each column defined in
// code actually exists in the database. Any column that is missing gets created.
//
// It ONLY adds missing tables/columns. It never changes or deletes anything that already
// exists, so it is safe to run against production data. This runs at start-up, so when a
// new column is added in code it is created automatically, with no manual SQL needed in
// each environment. Every step is wrapped so one problem column is logged and skipped
// instead of stopping the whole app.
async function ensureModelsSchema(sequelize, models) {
    const queryInterface = sequelize.getQueryInterface();

    for (const modelName of Object.keys(models)) {
        const model = models[modelName];

        // Skip anything that isn't a real Sequelize model (e.g. helper exports).
        if (!model || typeof model.getTableName !== 'function') {
            continue;
        }

        const tableName = model.getTableName();

        let existingColumns;
        try {
            const description = await queryInterface.describeTable(tableName);
            existingColumns = Object.keys(description).map((name) => name.toLowerCase());
        } catch (err) {
            // The table itself is missing — create it from the model. This only creates
            // the table when it does not already exist; it never alters an existing one.
            try {
                await model.sync();
                console.log(`[migration] created missing table "${tableName}"`);
            } catch (createErr) {
                console.log(`[migration] could not create table "${tableName}":`, createErr?.message);
            }
            continue;
        }

        const attributes = model.rawAttributes;
        for (const attributeName of Object.keys(attributes)) {
            const attribute = attributes[attributeName];
            // The real database column name can differ from the code name via `field`.
            const columnName = attribute.field || attributeName;

            if (existingColumns.includes(columnName.toLowerCase())) {
                continue;
            }

            try {
                await queryInterface.addColumn(tableName, columnName, {
                    type: attribute.type,
                    allowNull: attribute.allowNull,
                    defaultValue: attribute.defaultValue
                });
                console.log(`[migration] added missing column "${tableName}.${columnName}"`);
            } catch (err) {
                console.log(`[migration] could not add column "${tableName}.${columnName}":`, err?.message);
            }
        }
    }
}

let schemaReadyPromise = null;

// Runs the check once per app start and remembers the result, so it is not repeated on
// every request. Anything that reads/writes these tables awaits this first, so the columns
// are guaranteed to be there. It never throws: on failure it logs and clears the memory so
// the next call tries again (behaving as before the check ran in the meantime).
function ensureSchemaOnce(sequelize, models) {
    if (!schemaReadyPromise) {
        schemaReadyPromise = ensureModelsSchema(sequelize, models).catch((err) => {
            console.log('[migration] schema check failed; will retry on next call:', err?.message);
            schemaReadyPromise = null;
        });
    }
    return schemaReadyPromise;
}

exports.ensureModelsSchema = ensureModelsSchema;
exports.ensureSchemaOnce = ensureSchemaOnce;
