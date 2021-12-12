/*
 *  Name: "schema-import.js"
 *  Version: "0.1.0"
 *  Description: import schema generated by schema-sampler.js
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet schema-import.js"

let __script = { "name": "schema-import.js", "version": "0.1.0" };
print('\n', 'Running script', __script.name, 'v' + __script.version);

let userOptions = {
    /*
     *  user preferences
     */
    schemaFile: 'schema.json',
    readPreference: 'primaryPreferred'
}

function main(userOptions) {
    /*
     *  main
     */
    db.getMongo().setReadPref(userOptions.readPreference);
    let schema = loadSchemaFile(userOptions.schemaFile);
    let dbs = listDBs(schema);
    // pretty(dbs);
    // parse and create DB namespaces
    // parse and create collections with data
    // parse and create indexes
    // parse and create views

    return;
}

function loadSchemaFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch(e) {
        console.log('Error:', e.stack);
    }

    return;
}

function listDBs(schema) {
    let dbNames = [];
    for (let i = 0; i < schema.length; ++i) {
        print(schema[i].db);
    }

    return dbNames;
}

function pretty(json) {
    /*
     *  report
     */
    print('\n');
    // print(JSON.stringify(schema, null, '  '));
    print(json);
    print('\n');

    return;
}

main(userOptions);

// EOF