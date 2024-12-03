## Example of encrypting files in nodejs & then decrypting in browser

The [encrypt.ts](encrypt.ts) creates a zip archive that contains:
 * a manifest.json _semi documented in  [types.ts](types.ts)_
 * a [results.csv](results.csv) file

A zip archive was chosen for the container format because it's very well supported and files can be extracted individually without decompressing the entire archive.

Entries in the manifest.json file are signed using the private key to ensure they are not tampered with and to create an audit trail

Each file is encrypted as it's added to the zip.

The [server.ts](server.ts) starts a expressjs server that renders a simple html webpage with a text box.

A user inputs the private key from [../support/private_key.pem](../support/private_key.pem) into the text box, the zip file is then fetched and:
 * manifest.json is extracted and it's audit trail validated by checking the signature using the members public key.
 * each file is listed and it's info looked up in the manifest
 * using the key & iv from manifest, the data for the file is extracted and displayed

The above steps occur completely in browser in [client.ts](client.ts) The only external library utilized is [zip.js](https://gildas-lormeau.github.io/zip.js/) to unzip the results, all cryptography is performed using the built-in [crypto.subtle](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle) API.

### usage

run server: `npx tsx server.ts`

open http://localhost:7080/

`cat ../support/private_key.pem | pbcopy` to add private key to clipboard and then paste it into text box.

#### the public and private keys were intentionally committed to this repository

various GitHub scanners *really* do not like including private RSA keys in a public repository, however these are included **ONLY** for demonstration purposes and are not used in any deployed system.
