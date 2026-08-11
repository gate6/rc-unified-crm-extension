// @ts-nocheck
// Monday work management.
//
// A Monday account keeps its people on one board (Contacts/Leads) and its work on others — one
// board per project. The people board is where App Connect matches the caller; the project board
// is where the team actually reads. So the call/message log form offers a Project dropdown: pick
// one of the project boards and the interaction is written to that project's item for the caller
// IN ADDITION to the contact's own item, which stays the log's system of record.
//
// Inside the chosen project board the caller's item is found by name. When the project has no item
// for them yet one is created and connected back to their contact item through a "connect boards"
// column, so the project item always points at the person it belongs to.
//
// Everything project-related lives here — workspace/board selection, dropdown options, item
// lookup and creation, the relation link, update mirroring and the composite log id. The caller
// passes in the already-discovered board list and access token, which keeps this module free of a
// circular require back into the connector and testable on its own.

const { mondayRequest, isNumericMondayId } = require('./client');

const PROJECT_OPTION_NONE = 'none';
const PROJECT_OPTION_NONE_TITLE = 'None (log to contact only)';
const PROJECT_OPTION_CREATE_NEW = 'createNewProject';
const PROJECT_OPTION_CREATE_NEW_TITLE = 'Create new project...';

// Boards that sit outside any named workspace (Monday's default "Main workspace") come back with a
// null workspace, so they need a stable stand-in key to be selectable in the settings dropdown.
const MAIN_WORKSPACE_ID = 'main';
const MAIN_WORKSPACE_NAME = 'Main workspace';

// Titles of the columns a project board is given when it doesn't have them. Each is reused when the
// board already has an equivalent — matched on what the column IS, not what it is called, so a
// renamed column is filled in rather than duplicated next to a new one.
const CONTACT_RELATION_COLUMN_TITLE = 'Customer';
const LAST_LOGGED_BY_COLUMN_TITLE = 'Last logged by';
const LAST_ACTIVITY_COLUMN_TITLE = 'Last activity';
const STATUS_COLUMN_TITLE = 'Status';

// The status a project item opens on when the agent doesn't pick one. An unpicked status on a
// FOLLOW-UP call leaves the column alone: a CSR moves it to Stuck or Done as the work moves, and
// another call is not a reason to overwrite that judgement. Written with create_labels_if_missing,
// so a board whose status column uses different labels gains this one rather than rejecting the write.
const NEW_ITEM_STATUS_LABEL = 'Working on it';

// What the Status dropdown on the log form offers. Monday's own default status column ships with
// exactly these three, so a board created here — or any untouched board — already knows them.
const PROJECT_STATUS_LABELS = ['Working on it', 'Stuck', 'Done'];

// Board columns are per project board and never change once resolved, so the lookups are cached for
// the life of the process like the client's column cache.
const relationColumnCache = new Map();
const boardColumnCache = new Map();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function isProjectLoggingEnabled(user) {
    return (user?.userSettings?.logCallToProject?.value ?? true) === true;
}

function getConfiguredWorkspaceName(user) {
    return String(user?.userSettings?.projectsWorkspaceName?.value ?? '').trim();
}

// Raising a whole new board from a phone call is a bigger commitment than filing a note on one, so
// it is a switch an admin can turn off. It is on by default: the point of the feature is that a CSR
// taking a call about work nobody has a board for yet doesn't have to leave the call to make one.
function isProjectCreationEnabled(user) {
    return (user?.userSettings?.allowCreateProject?.value ?? true) === true;
}

// ---------------------------------------------------------------------------
// Workspaces and project boards
// ---------------------------------------------------------------------------

function workspaceNameOf(board) {
    return board?.workspaceName || MAIN_WORKSPACE_NAME;
}

// The workspace is typed by hand into a settings text field, so it is matched forgivingly: case and
// spacing are ignored, the same leniency ServiceTitan documents for its typed default job type.
// "prOJec t s" therefore finds "Projects".
function normalizeWorkspaceName(name) {
    return String(name ?? '').toLowerCase().replace(/\s+/g, '');
}

// The workspaces a connected user can see, derived from the board list the connector already
// fetched rather than costing a `workspaces` query of its own. Used to say what the real names are
// when a configured one matches nothing.
function listWorkspaces(boards = []) {
    const seen = new Map();
    for (const board of boards) {
        const name = workspaceNameOf(board);
        const key = normalizeWorkspaceName(name);
        if (!seen.has(key)) {
            seen.set(key, { id: board?.workspaceId != null ? String(board.workspaceId) : MAIN_WORKSPACE_ID, name });
        }
    }
    return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Which boards count as projects: every board in the named workspace when an admin named one, and
// every board in the account when they did not. The contact board is never among them — logging to
// the caller's own contact item is what the connector does anyway — and neither are Monday's
// non-board objects (sub-item boards, docs, custom objects), which cannot hold a project item.
//
// A name that matches no workspace falls back to offering everything rather than an empty dropdown:
// an agent mid-call should still be able to file the call somewhere. The warning is loud because a
// typo here is otherwise invisible — the dropdown simply grows.
function listProjectBoards({ user, boards = [], contactBoardId }) {
    const selectable = boards
        .filter(board => !board.type || board.type === 'board')
        .filter(board => String(board.id) !== String(contactBoardId ?? ''))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const configured = getConfiguredWorkspaceName(user);
    if (!configured) {
        return selectable;
    }
    const wanted = normalizeWorkspaceName(configured);
    const inWorkspace = selectable.filter(board => normalizeWorkspaceName(workspaceNameOf(board)) === wanted);
    if (inWorkspace.length) {
        return inWorkspace;
    }
    console.warn(
        `[Monday][projects] no workspace matches the configured projects workspace "${configured}" — check the spelling in settings. Offering every board instead.`,
        { availableWorkspaces: listWorkspaces(boards).map(w => w.name) }
    );
    return selectable;
}

function buildProjectOptions({ projectBoards = [], allowCreate = false } = {}) {
    const options = [
        { const: PROJECT_OPTION_NONE, title: PROJECT_OPTION_NONE_TITLE },
        ...projectBoards.map(board => ({ const: String(board.id), title: board.name }))
    ];
    // "Create new project" goes last, after every board that already exists, so filing the call
    // against work that is already tracked stays at the top of the list and raising a whole new
    // board is a deliberate scroll rather than a mis-click.
    if (allowCreate) {
        options.push({
            const: PROJECT_OPTION_CREATE_NEW,
            title: PROJECT_OPTION_CREATE_NEW_TITLE,
            description: 'Name it in the "New project name" field'
        });
    }
    return options;
}

function buildStatusOptions() {
    return PROJECT_STATUS_LABELS.map(label => ({ const: label, title: label }));
}

// The Project dropdown is `contactDependent`, so its options have to travel back attached to the
// matched contact. The option list is the same for every contact — it is the board list, not the
// person — so this costs no extra API call beyond the board discovery the lookup already did.
function buildProjectAdditionalInfo({ user, boards = [], contactBoard }) {
    if (!isProjectLoggingEnabled(user) || !boards.length) {
        // With no board list there is nothing to choose from, and a dropdown offering only "None"
        // reads as "this account has no projects" — which would be a lie about a cold cache.
        return null;
    }
    const projectBoards = listProjectBoards({ user, boards, contactBoardId: contactBoard?.id });
    return {
        project: buildProjectOptions({ projectBoards, allowCreate: isProjectCreationEnabled(user) }),
        projectStatus: buildStatusOptions()
    };
}

// The workspace a new project board is raised in: the one the admin named, resolved to its id
// through a board that already sits in it. With no name configured — or a name matching nothing —
// Monday puts the board in the account's main workspace, which is the only sane default available.
function resolveNewBoardWorkspaceId({ user, boards = [] }) {
    const configured = getConfiguredWorkspaceName(user);
    if (!configured) return null;
    const wanted = normalizeWorkspaceName(configured);
    const inWorkspace = boards.find(board => normalizeWorkspaceName(workspaceNameOf(board)) === wanted);
    if (!inWorkspace) {
        console.warn(`[Monday][projects] no workspace matches "${configured}", so the new project board goes to the main workspace`);
        return null;
    }
    return inWorkspace.workspaceId != null ? String(inWorkspace.workspaceId) : null;
}

// Raise a board for work nobody has one for yet. The columns are not created here: the item write
// that follows resolves them the same way it does on any other board, so a board made here and a
// board made by hand end up identical.
async function createProjectBoard({ user, accessToken, boards = [], name, operation = 'createProjectBoard' }) {
    const boardName = String(name ?? '').trim();
    if (!boardName) {
        throw new Error('a project name is required');
    }
    const workspaceId = resolveNewBoardWorkspaceId({ user, boards });
    const res = await mondayRequest(
        accessToken,
        `
        mutation ($name: String!, $workspaceId: ID) {
          create_board(board_name: $name, board_kind: public, workspace_id: $workspaceId) {
            id
            name
          }
        }
        `,
        { name: boardName, workspaceId },
        { operation }
    );
    if (res?.errors?.length || !res?.data?.create_board?.id) {
        throw new Error(res?.errors?.[0]?.message || 'create_board failed');
    }
    const board = res.data.create_board;
    seedEmptyBoardColumns(board.id);
    console.log('[Monday][projects] created a project board', { boardId: board.id, name: board.name, workspaceId });
    return board;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// Find the project's item for a person by name. An exact (case- and space-insensitive) match wins;
// failing that the first partial match is used, because a project item is often named for the
// person plus the work ("Emma Stone - kitchen"). Returns null when the project has no item for them.
async function findItemByName({ accessToken, boardId, name, operation = 'findProjectItem' }) {
    const term = String(name ?? '').trim();
    if (!boardId || !term) return null;

    // Inline the search term via JSON.stringify so it is a safely-escaped GraphQL list literal
    // (e.g. ["O'Brien"]). compare_value is Monday's JSON CompareValue scalar.
    const compareValue = JSON.stringify([term]);
    const res = await mondayRequest(
        accessToken,
        `
        query ($boardId: [ID!]) {
          boards(ids: $boardId) {
            items_page(
              limit: 50,
              query_params: { rules: [{ column_id: "name", compare_value: ${compareValue}, operator: contains_text }] }
            ) {
              items { id name }
            }
          }
        }
        `,
        { boardId: [String(boardId)] },
        { operation }
    );
    if (res?.errors?.length) {
        console.warn('[Monday][projects] item lookup failed on board', boardId, res.errors[0]?.message);
        return null;
    }
    const items = res?.data?.boards?.[0]?.items_page?.items || [];
    const normalized = term.toLowerCase().replace(/\s+/g, ' ');
    return items.find(item => String(item.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === normalized)
        || items[0]
        || null;
}

// A project board's columns, read once and cached. Every column the connector fills is resolved
// from this one query rather than a lookup each.
async function getBoardColumns({ accessToken, boardId, operation }) {
    if (boardColumnCache.has(String(boardId))) {
        return boardColumnCache.get(String(boardId));
    }
    const res = await mondayRequest(
        accessToken,
        `
        query ($boardId: [ID!]) {
          boards(ids: $boardId) {
            columns { id title type settings_str }
          }
        }
        `,
        { boardId: [String(boardId)] },
        { operation }
    );
    if (res?.errors?.length) return [];
    const columns = res?.data?.boards?.[0]?.columns || [];
    if (columns.length) boardColumnCache.set(String(boardId), columns);
    return columns;
}

// Record a column the connector just added, so the next lookup on the same board sees it without
// re-reading the board. Filling four columns on a fresh board otherwise costs four extra board
// queries — the agent is waiting on all of them mid-call.
function rememberBoardColumn(boardId, column) {
    const cached = boardColumnCache.get(String(boardId));
    if (Array.isArray(cached)) {
        cached.push(column);
    } else {
        boardColumnCache.set(String(boardId), [column]);
    }
}

// A board this connector created moments ago has no columns worth reading back, so its (empty)
// column list is seeded rather than queried.
function seedEmptyBoardColumns(boardId) {
    boardColumnCache.set(String(boardId), []);
}

// The connect-boards column linking a project board's items back to the contact board. Matched on
// the board it targets rather than its title, so a renamed column is reused instead of a second one
// being created next to it.
async function findContactRelationColumn({ accessToken, projectBoardId, contactBoardId, operation }) {
    const columns = await getBoardColumns({ accessToken, boardId: projectBoardId, operation });
    const matched = columns.find(col => {
        if (col.type !== 'board_relation') return false;
        try {
            const boardIds = JSON.parse(col.settings_str || '{}')?.boardIds || [];
            return boardIds.some(id => String(id) === String(contactBoardId));
        } catch (e) {
            return false;
        }
    });
    return matched?.id || null;
}

// A column of `type` on the project board: the one titled as we would title it, else — only where
// that is safe — any column of that type already there, else a new one. `allowTypeMatch` is off for
// status columns on purpose: boards routinely carry several (Priority, Stage), and writing "Working
// on it" into a Priority column would be worse than adding the column we meant. Never throws — a
// column that cannot be resolved is simply not written, which costs a detail on the item, nothing more.
async function getOrCreateColumn({ accessToken, boardId, type, title, defaults, allowTypeMatch = false, operation }) {
    const cacheKey = `${boardId}:${type}:${title}`;
    if (boardColumnCache.has(cacheKey)) {
        return boardColumnCache.get(cacheKey);
    }
    try {
        const columns = await getBoardColumns({ accessToken, boardId, operation });
        const wanted = String(title).trim().toLowerCase();
        const matched = columns.find(col => col.type === type && String(col.title ?? '').trim().toLowerCase() === wanted)
            || (allowTypeMatch ? columns.find(col => col.type === type) : null);
        if (matched?.id) {
            boardColumnCache.set(cacheKey, matched.id);
            return matched.id;
        }
        const res = await mondayRequest(
            accessToken,
            `
            mutation ($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
              create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) {
                id
              }
            }
            `,
            { boardId: String(boardId), title, type, defaults: defaults ? JSON.stringify(defaults) : null },
            { operation }
        );
        if (res?.errors?.length) {
            console.warn(`[Monday][projects] could not create the "${title}" column`, { boardId, error: res.errors[0]?.message });
            return null;
        }
        const created = res?.data?.create_column?.id || null;
        if (created) {
            boardColumnCache.set(cacheKey, created);
            rememberBoardColumn(boardId, { id: created, title, type, settings_str: '{}' });
        }
        return created;
    } catch (e) {
        console.warn(`[Monday][projects] resolving the "${title}" column failed`, { boardId, message: e.message });
        return null;
    }
}

// Never throws: the link is a convenience on top of the item, and a project board on a Monday plan
// without connect-boards columns must still get its log.
async function getOrCreateContactRelationColumn({ accessToken, projectBoardId, contactBoardId, operation = 'linkProjectItem' }) {
    if (!projectBoardId || !contactBoardId) return null;
    const cacheKey = `${projectBoardId}:${contactBoardId}`;
    if (relationColumnCache.has(cacheKey)) {
        return relationColumnCache.get(cacheKey);
    }
    try {
        let columnId = await findContactRelationColumn({ accessToken, projectBoardId, contactBoardId, operation });
        if (!columnId) {
            const createColumn = (defaults) => mondayRequest(
                accessToken,
                `
                mutation ($boardId: ID!, $title: String!, $defaults: JSON!) {
                  create_column(board_id: $boardId, title: $title, column_type: board_relation, defaults: $defaults) {
                    id
                  }
                }
                `,
                {
                    boardId: String(projectBoardId),
                    title: CONTACT_RELATION_COLUMN_TITLE,
                    defaults: JSON.stringify(defaults)
                },
                { operation }
            );

            // Two-way on purpose: `allowCreateReflectionColumn` asks monday.com to mirror this link
            // back onto the contacts board, so opening a customer shows the projects they are on
            // without anyone maintaining a second list. Each project board contributes its own
            // mirrored column there, named after the board.
            let res = await createColumn({ boardIds: [Number(contactBoardId)], allowCreateReflectionColumn: true });
            if (res?.errors?.length) {
                // Not every plan allows a mirrored column. A one-way link still identifies the
                // customer's item, which is what the logging itself depends on.
                console.warn('[Monday][projects] two-way contact link rejected; falling back to a one-way link', { projectBoardId, error: res.errors[0]?.message });
                res = await createColumn({ boardIds: [Number(contactBoardId)] });
            }
            if (res?.errors?.length) {
                console.warn('[Monday][projects] could not create the contact link column', { projectBoardId, error: res.errors[0]?.message });
                return null;
            }
            columnId = res?.data?.create_column?.id || null;
            if (columnId) {
                rememberBoardColumn(projectBoardId, {
                    id: columnId,
                    title: CONTACT_RELATION_COLUMN_TITLE,
                    type: 'board_relation',
                    settings_str: JSON.stringify({ boardIds: [Number(contactBoardId)] })
                });
            }
        }
        if (columnId) relationColumnCache.set(cacheKey, columnId);
        return columnId;
    } catch (e) {
        console.warn('[Monday][projects] contact link column lookup failed', { projectBoardId, message: e.message });
        return null;
    }
}

// The project's item for a customer, found by the connect-boards column rather than by name. This is
// the authoritative lookup: two customers can share a name, one customer's name can be spelled three
// ways, and a project item is often titled for the person plus the work — but a link to their
// contact item is exact. It is what keeps a project to one item per customer.
async function findItemByContactRelation({ accessToken, boardId, relationColumnId, contactItemId, operation = 'findProjectItem' }) {
    if (!relationColumnId || !contactItemId) return null;
    const compareValue = JSON.stringify([String(contactItemId)]);
    const res = await mondayRequest(
        accessToken,
        `
        query ($boardId: [ID!]) {
          boards(ids: $boardId) {
            items_page(
              limit: 50,
              query_params: { rules: [{ column_id: "${relationColumnId}", compare_value: ${compareValue}, operator: any_of }] }
            ) {
              items { id name }
            }
          }
        }
        `,
        { boardId: [String(boardId)] },
        { operation }
    );
    if (res?.errors?.length) {
        // Filtering on a connect-boards column is not supported on every Monday plan or API version.
        // The caller falls back to matching by name, which is what this replaced.
        console.warn('[Monday][projects] lookup by customer link failed; falling back to name', { boardId, error: res.errors[0]?.message });
        return null;
    }
    return res?.data?.boards?.[0]?.items_page?.items?.[0] || null;
}

// Create the item with everything it needs in one mutation: the customer link that identifies it,
// the status it opens on, and who logged the call that raised it. Doing it in `create_item` rather
// than as follow-up writes means an item never exists in a half-filled state, and costs one request
// instead of three.
async function createProjectItem({ accessToken, projectBoardId, name, columnValues, operation = 'createProjectItem' }) {
    const res = await mondayRequest(
        accessToken,
        `
        mutation ($boardId: ID!, $name: String!, $values: JSON) {
          create_item(board_id: $boardId, item_name: $name, column_values: $values, create_labels_if_missing: true) {
            id
            name
          }
        }
        `,
        {
            boardId: String(projectBoardId),
            name: String(name),
            values: Object.keys(columnValues || {}).length ? JSON.stringify(columnValues) : null
        },
        { operation }
    );
    if (res?.errors?.length || !res?.data?.create_item?.id) {
        throw new Error(res?.errors?.[0]?.message || 'create_item failed');
    }
    return res.data.create_item;
}

// Update columns on an item that already exists — the "last logged by" stamp on every later call,
// and the customer link when an item matched by name turns out not to carry one yet. Never throws.
async function setItemColumns({ accessToken, boardId, itemId, columnValues, operation = 'projectItemColumns' }) {
    if (!itemId || !Object.keys(columnValues || {}).length) return false;
    try {
        const res = await mondayRequest(
            accessToken,
            `
            mutation ($itemId: ID!, $boardId: ID!, $values: JSON!) {
              change_multiple_column_values(item_id: $itemId, board_id: $boardId, column_values: $values, create_labels_if_missing: true) {
                id
              }
            }
            `,
            { itemId: String(itemId), boardId: String(boardId), values: JSON.stringify(columnValues) },
            { operation }
        );
        if (res?.errors?.length) {
            console.warn('[Monday][projects] could not write the project item columns', { itemId, error: res.errors[0]?.message });
            return false;
        }
        return !!res?.data?.change_multiple_column_values?.id;
    } catch (e) {
        console.warn('[Monday][projects] writing the project item columns failed', { itemId, message: e.message });
        return false;
    }
}

// Monday date columns hold UTC and render in each viewer's own timezone, so the interaction's own
// timestamp goes in as UTC rather than being shifted into anyone's local time first.
function toMondayDateValue(time) {
    const at = time ? new Date(time) : new Date();
    const iso = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

// The column values that describe a project item: who it is for, when it was last heard from, who
// logged that, and where the work stands.
//
// `statusLabel` is the label to write, or null to leave the status column untouched — see
// resolveStatusLabel. `includeRelation` is false when the item was found BY that link, where
// rewriting it would be a pointless no-op, and true when it was created or matched by name and
// needs the link written.
async function buildItemColumnValues({ accessToken, projectBoardId, contactBoardId, contactItemId, mondayUserId, activityTime, statusLabel, includeRelation = true, operation }) {
    const values: any = {};

    const relationColumnId = await getOrCreateContactRelationColumn({ accessToken, projectBoardId, contactBoardId, operation });
    if (includeRelation && relationColumnId && contactItemId) {
        values[relationColumnId] = { item_ids: [Number(contactItemId)] };
    }

    if (mondayUserId) {
        const personColumnId = await getOrCreateColumn({
            accessToken,
            boardId: projectBoardId,
            type: 'people',
            title: LAST_LOGGED_BY_COLUMN_TITLE,
            allowTypeMatch: true,
            operation
        });
        if (personColumnId) {
            values[personColumnId] = { personsAndTeams: [{ id: Number(mondayUserId), kind: 'person' }] };
        }
    }

    // Matched by title only: boards are full of date columns that mean something else entirely
    // (Due date, Start date), and stamping a call time into one of those would be worse than
    // adding the column meant here.
    const dateColumnId = await getOrCreateColumn({
        accessToken,
        boardId: projectBoardId,
        type: 'date',
        title: LAST_ACTIVITY_COLUMN_TITLE,
        operation
    });
    if (dateColumnId) {
        values[dateColumnId] = toMondayDateValue(activityTime);
    }

    if (statusLabel) {
        const statusColumnId = await getOrCreateColumn({
            accessToken,
            boardId: projectBoardId,
            type: 'status',
            title: STATUS_COLUMN_TITLE,
            operation
        });
        if (statusColumnId) {
            values[statusColumnId] = { label: statusLabel };
        }
    }

    return { values, relationColumnId };
}

// Which status a log writes, if any:
//   the agent picked one   -> that one, whether the item is new or not. This is how a customer
//                             raising a fresh request on an existing item moves it off Done.
//   nobody picked, new item -> the opening status, so an item never starts blank.
//   nobody picked, existing -> nothing. Automatic logging submits no form at all, and it must not
//                             quietly reopen work the team has closed.
function resolveStatusLabel({ additionalSubmission, isNewItem }) {
    const picked = String(additionalSubmission?.projectStatus ?? '').trim();
    if (picked) return picked;
    return isNewItem ? NEW_ITEM_STATUS_LABEL : null;
}

// The name of a contact item, for the paths that only carry its id (log updates, where core passes
// the stored contactId but no contact record).
async function getItemName({ accessToken, itemId, operation = 'getItemName' }) {
    if (!isNumericMondayId(itemId)) return null;
    try {
        const res = await mondayRequest(
            accessToken,
            `
            query ($ids: [ID!]) {
              items(ids: $ids) { id name }
            }
            `,
            { ids: [String(itemId)] },
            { operation }
        );
        if (res?.errors?.length) return null;
        return res?.data?.items?.[0]?.name ?? null;
    } catch (e) {
        console.warn('[Monday][projects] could not read the item name', { itemId, message: e.message });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

// Works out which project item a log should additionally be written to. Never throws and never
// blocks the log: any project problem returns a null item with a warning, because the interaction
// always reaches the contact's own item regardless and losing it would be far worse than filing it
// in one place instead of two.
//
// No pick covers both an agent leaving the dropdown alone and automatic logging, which submits
// nothing at all — both log to the contact only. There is deliberately no "default project": a
// project is a statement about what the call was about, and guessing it wrong files work under the
// wrong customer engagement.
async function resolveTargetProjectItem({ user, accessToken, additionalSubmission, contactInfo, contactBoard, boards = [], mondayUserId, activityTime, logPrefix = '[Monday][projects]', operation = 'resolveProjectItem' }) {
    if (!isProjectLoggingEnabled(user)) {
        return { boardId: null, itemId: null };
    }
    const selected = String(additionalSubmission?.project ?? '').trim();
    if (!selected || selected === PROJECT_OPTION_NONE) {
        return { boardId: null, itemId: null };
    }

    const creatingProject = selected === PROJECT_OPTION_CREATE_NEW;

    // The dropdown options were built when the contact matched, so the board may have been archived
    // or moved out of the projects workspace since.
    const projectBoards = listProjectBoards({ user, boards, contactBoardId: contactBoard?.id });
    if (!creatingProject && projectBoards.length && !projectBoards.some(board => String(board.id) === selected)) {
        console.warn(`${logPrefix} selected project board is no longer offered as a project`, { selected });
        return { boardId: null, itemId: null, warning: 'That project is no longer available, so it was logged to the contact only.' };
    }
    if (creatingProject && !isProjectCreationEnabled(user)) {
        return { boardId: null, itemId: null, warning: 'Creating projects is switched off, so it was logged to the contact only.' };
    }

    const contactName = String(contactInfo?.name ?? '').trim()
        || await getItemName({ accessToken, itemId: contactInfo?.id, operation });
    if (!contactName) {
        return { boardId: null, itemId: null, warning: 'The contact has no name to match a project item on, so it was logged to the contact only.' };
    }

    try {
        // A brand-new project board has no items and no columns to speak of, so the lookups below
        // are skipped entirely — the customer's item is necessarily the first one on it.
        let boardId = selected;
        let createdBoard = null;
        if (creatingProject) {
            createdBoard = await createProjectBoard({
                user,
                accessToken,
                boards,
                name: additionalSubmission?.newProjectName,
                operation
            });
            boardId = String(createdBoard.id);
        }

        // A customer gets ONE item per project, and every later call collects on it as another
        // update. The link to their contact item is what identifies that item; the name is only a
        // fallback for boards where filtering on a connect-boards column isn't available, and for
        // items somebody created by hand before the link existed.
        let existing = null;
        let matchedByName = false;
        if (!createdBoard) {
            const relationColumnId = await getOrCreateContactRelationColumn({
                accessToken,
                projectBoardId: boardId,
                contactBoardId: contactBoard?.id,
                operation
            });
            existing = await findItemByContactRelation({
                accessToken,
                boardId,
                relationColumnId,
                contactItemId: contactInfo?.id,
                operation
            });
            if (!existing) {
                existing = await findItemByName({ accessToken, boardId, name: contactName, operation });
                matchedByName = !!existing;
            }
        }

        const { values } = await buildItemColumnValues({
            accessToken,
            projectBoardId: boardId,
            contactBoardId: contactBoard?.id,
            contactItemId: contactInfo?.id,
            mondayUserId,
            activityTime,
            statusLabel: resolveStatusLabel({ additionalSubmission, isNewItem: !existing }),
            // An item found by its link already has it; one found by name is missing it.
            includeRelation: !existing || matchedByName,
            operation
        });

        if (existing) {
            // Stamp when this call came in and who logged it. An item matched by name also gains the
            // customer link here, so the next call finds it exactly rather than by name again.
            await setItemColumns({ accessToken, boardId, itemId: existing.id, columnValues: values, operation });
            return { boardId, itemId: String(existing.id), name: existing.name, created: false };
        }

        const created = await createProjectItem({
            accessToken,
            projectBoardId: boardId,
            name: contactName,
            columnValues: values,
            operation
        });
        console.log(`${logPrefix} created a project item for the contact`, { projectBoardId: boardId, itemId: created.id, name: contactName });
        return {
            boardId,
            itemId: String(created.id),
            name: created.name,
            created: true,
            // Tells the caller its cached board list is now out of date.
            createdBoard: createdBoard ? { id: String(createdBoard.id), name: createdBoard.name } : null
        };
    } catch (err) {
        console.warn(`${logPrefix} could not resolve the project item:`, err.message);
        return { boardId: null, itemId: null, warning: `Could not add this to the project (${err.message}). It was logged to the contact only.` };
    }
}

// The board an item belongs to. Needed by the paths that know a project item only from the stored
// log id — writing a column requires the board as well as the item.
async function getItemBoardId({ accessToken, itemId, operation = 'getItemBoardId' }) {
    if (!isNumericMondayId(itemId)) return null;
    try {
        const res = await mondayRequest(
            accessToken,
            `
            query ($ids: [ID!]) {
              items(ids: $ids) { id board { id } }
            }
            `,
            { ids: [String(itemId)] },
            { operation }
        );
        if (res?.errors?.length) return null;
        const boardId = res?.data?.items?.[0]?.board?.id;
        return boardId != null ? String(boardId) : null;
    } catch (e) {
        console.warn('[Monday][projects] could not read the item board', { itemId, message: e.message });
        return null;
    }
}

// Refresh "Last activity" and "Last logged by" on a project item that is already known — the case
// where a conversation continues and no item resolution is needed. The status and the customer link
// are left alone: the item is already the customer's, and where the work stands is the team's call.
async function stampProjectActivity({ accessToken, projectBoardId, projectItemId, contactBoardId, mondayUserId, activityTime, operation = 'stampProjectItem' }) {
    if (!projectItemId) return false;
    const boardId = projectBoardId || await getItemBoardId({ accessToken, itemId: projectItemId, operation });
    if (!boardId) return false;
    const { values } = await buildItemColumnValues({
        accessToken,
        projectBoardId: boardId,
        contactBoardId,
        mondayUserId,
        activityTime,
        statusLabel: null,
        includeRelation: false,
        operation
    });
    return setItemColumns({ accessToken, boardId, itemId: projectItemId, columnValues: values, operation });
}

// ---------------------------------------------------------------------------
// Updates on the project item
//
// The project copy is a mirror of the contact item's update: the same body, written a second time.
// Every helper below swallows its failures — the contact item is the log's system of record, so a
// project write that fails must never fail the log itself.
// ---------------------------------------------------------------------------

async function postUpdate({ accessToken, itemId, body, operation = 'projectUpdate' }) {
    if (!itemId || !body) return null;
    try {
        const res = await mondayRequest(
            accessToken,
            `
            mutation ($itemId: ID!, $body: String!) {
              create_update(item_id: $itemId, body: $body) {
                id
              }
            }
            `,
            { itemId: String(itemId), body },
            { operation }
        );
        if (res?.errors?.length) {
            console.warn('[Monday][projects] could not write the update to the project item', { itemId, error: res.errors[0]?.message });
            return null;
        }
        return res?.data?.create_update?.id ?? null;
    } catch (e) {
        console.warn('[Monday][projects] writing the update to the project item failed', { itemId, message: e.message });
        return null;
    }
}

async function editUpdate({ accessToken, updateId, body, operation = 'projectUpdate' }) {
    if (!isNumericMondayId(updateId) || !body) return null;
    try {
        const res = await mondayRequest(
            accessToken,
            `
            mutation ($updateId: ID!, $body: String!) {
              edit_update(id: $updateId, body: $body) {
                id
              }
            }
            `,
            { updateId: String(updateId), body },
            { operation }
        );
        if (res?.errors?.length) return null;
        return res?.data?.edit_update?.id ?? null;
    } catch (e) {
        console.warn('[Monday][projects] editing the project update failed', { updateId, message: e.message });
        return null;
    }
}

async function deleteUpdate({ accessToken, updateId, operation = 'projectUpdate' }) {
    if (!isNumericMondayId(updateId)) return;
    try {
        await mondayRequest(
            accessToken,
            `
            mutation ($updateId: ID!) {
              delete_update(id: $updateId) {
                id
              }
            }
            `,
            { updateId: String(updateId) },
            { operation }
        );
    } catch (e) {
        console.warn('[Monday][projects] deleting the superseded project update failed — a duplicate may remain', { updateId, message: e.message });
    }
}

// Keep the project copy in step with an edited log: edit the existing update where one is known,
// and fall back to writing a fresh one when it has been deleted (or was never written, because the
// project was chosen only on this edit).
async function mirrorUpdate({ accessToken, projectItemId, projectUpdateId, body, operation = 'projectUpdate' }) {
    if (!projectItemId || !body) return null;
    const edited = await editUpdate({ accessToken, updateId: projectUpdateId, body, operation });
    if (edited) return String(edited);
    return postUpdate({ accessToken, itemId: projectItemId, body, operation });
}

// SMS threads are recreated rather than edited so the conversation surfaces at the top of the
// item's update feed (Monday orders updates by creation time and edit_update does not move one) —
// the same reason the connector recreates the contact item's thread.
async function mirrorThread({ accessToken, projectItemId, projectUpdateId, body, operation = 'projectUpdate' }) {
    if (!projectItemId || !body) return null;
    const newId = await postUpdate({ accessToken, itemId: projectItemId, body, operation });
    if (!newId) return projectUpdateId ? String(projectUpdateId) : null;
    if (projectUpdateId && String(projectUpdateId) !== String(newId)) {
        await deleteUpdate({ accessToken, updateId: projectUpdateId, operation });
    }
    return String(newId);
}

// ---------------------------------------------------------------------------
// Log ids
//
// A log's id does two jobs at once, and the second one dictates its shape.
//
// It has to carry the project copy, because the models App Connect stores logs in (CallLogModel /
// MessageLogModel) hold exactly one connector-owned string — `thirdPartyLogId` — and a later edit or
// recording sync has to find BOTH updates from it.
//
// It also has to be the monday.com page that "view log details" opens. App Connect substitutes
// {logId} into ONE fixed `logPageUrl` template with no way to branch on the kind of log, and this
// connector's logs live on two different items — so carrying the path in the id is the only way the
// link can reach the item the agent actually filed the call against. ServiceTitan's connector does
// the same thing for the same reason.
//
//   contact only    ->  boards/7408120943/pulses/12554136015?u=5449375289
//   with a project  ->  boards/18426008270/pulses/12770522211?u=5449375640&cu=5449375289
//
// The query string carries what a path cannot: `u` is the update on the item the path points at, and
// `cu` the contact item's update when the path points at a project. monday.com ignores query
// parameters it doesn't recognise, so the id opens the right item either way.
//
// Ids in the two older shapes — a bare update id, and the `9876543~p5544332~u9876544` form that
// preceded the deep link — are still read, so logs written before this keep updating cleanly. Their
// "view log details" link cannot be recovered, because the item they point at was never recorded.
// ---------------------------------------------------------------------------

function buildLogId({ contactBoardId, contactItemId, contactUpdateId, projectBoardId, projectItemId, projectUpdateId }) {
    const onProject = !!(projectItemId && projectUpdateId);
    const boardId = onProject ? projectBoardId : contactBoardId;
    const itemId = onProject ? projectItemId : contactItemId;
    // Without an item to point at there is no page to open, so fall back to the older shape: it
    // still identifies the log for editing, which matters more than the link.
    if (!boardId || !itemId) {
        return onProject
            ? `${contactUpdateId ?? ''}~p${projectItemId}~u${projectUpdateId}`
            : String(contactUpdateId ?? '');
    }
    const params = new URLSearchParams({ u: String(onProject ? projectUpdateId : contactUpdateId) });
    if (onProject) params.set('cu', String(contactUpdateId ?? ''));
    return `boards/${boardId}/pulses/${itemId}?${params.toString()}`;
}

function parseLogId(thirdPartyLogId) {
    const raw = String(thirdPartyLogId ?? '');

    const path = raw.match(/^boards\/(\d+)\/pulses\/(\d+)(?:\?(.*))?$/);
    if (path) {
        const params = new URLSearchParams(path[3] || '');
        const onItem = params.get('u') || '';
        const contactUpdate = params.get('cu');
        // A `cu` means the path points at a project item, so `u` belongs to the project's copy.
        return contactUpdate !== null
            ? { updateId: contactUpdate, projectBoardId: path[1], projectItemId: path[2], projectUpdateId: onItem }
            : { updateId: onItem, projectBoardId: null, projectItemId: null, projectUpdateId: null };
    }

    const legacy = raw.match(/^([^~]*)~p([^~]+)~u(.+)$/);
    if (legacy) {
        return { updateId: legacy[1], projectBoardId: null, projectItemId: legacy[2], projectUpdateId: legacy[3] };
    }
    return { updateId: raw, projectBoardId: null, projectItemId: null, projectUpdateId: null };
}

module.exports = {
    PROJECT_OPTION_NONE,
    PROJECT_OPTION_NONE_TITLE,
    PROJECT_OPTION_CREATE_NEW,
    PROJECT_OPTION_CREATE_NEW_TITLE,
    PROJECT_STATUS_LABELS,
    MAIN_WORKSPACE_ID,
    MAIN_WORKSPACE_NAME,
    CONTACT_RELATION_COLUMN_TITLE,
    LAST_LOGGED_BY_COLUMN_TITLE,
    LAST_ACTIVITY_COLUMN_TITLE,
    STATUS_COLUMN_TITLE,
    NEW_ITEM_STATUS_LABEL,
    isProjectLoggingEnabled,
    isProjectCreationEnabled,
    getConfiguredWorkspaceName,
    normalizeWorkspaceName,
    workspaceNameOf,
    listWorkspaces,
    listProjectBoards,
    buildProjectOptions,
    buildStatusOptions,
    buildProjectAdditionalInfo,
    resolveNewBoardWorkspaceId,
    createProjectBoard,
    resolveStatusLabel,
    findItemByName,
    findItemByContactRelation,
    getOrCreateContactRelationColumn,
    getOrCreateColumn,
    buildItemColumnValues,
    setItemColumns,
    stampProjectActivity,
    createProjectItem,
    getItemName,
    getItemBoardId,
    toMondayDateValue,
    resolveTargetProjectItem,
    postUpdate,
    editUpdate,
    deleteUpdate,
    mirrorUpdate,
    mirrorThread,
    buildLogId,
    parseLogId
};

export {};
