## Example of using a JWT bearer token

The [request.ts](request.ts) generates a JWT using a RSA encoded **private** key and includes it in the Authorizable header.

The [server.ts](server.ts) then reads the **public** key and uses that to validate the JWT token from the Authorization header on a request.


### usage

run server: `npx tsx server.ts`

make a request: `npx tsx request.ts`


#### The keys were generated using these commands:

```bash
openssl genpkey -algorithm RSA -out private_key.pem -pkeyopt rsa_keygen_bits:4096
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

#### the public and private keys were intentionally committed to this repository

various GitHub scanners *really* do not like including private RSA keys in a public repository, however these are included **ONLY** for demonstration purposes and are not used in any deployed system.
