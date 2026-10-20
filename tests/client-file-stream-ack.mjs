import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'static/client.html'), 'utf8');
const marker = 'client.onfile = function(stream, mimetype, filename) {';
const start = html.indexOf(marker);
assert.notEqual(start, -1, 'client.onfile handler must exist');

const end = html.indexOf('function tracing_log(msg) {', start);
assert.ok(end > start, 'client onfile handler must be present');

let reader;
const acknowledgements = [];
const client = {};
const ctx = {
    client,
    Guacamole: {
        BlobReader: class {
            constructor() { reader = this; }
        },
        Status: { Code: { SUCCESS: 0 } }
    }
};
vm.createContext(ctx);
vm.runInContext(html.slice(start, end), ctx);

const stream = {
    sendAck(message, code) { acknowledgements.push({ message, code }); }
};
client.onfile(stream, 'text/plain', 'download.txt');
assert.deepEqual(acknowledgements, [
    { message: 'OK', code: 0 }
], 'the stream should be accepted once the reader is ready');

reader.onprogress();
assert.deepEqual(acknowledgements.at(-1), { message: 'Received', code: 0 });
console.log('client-file-stream-ack: ok');
