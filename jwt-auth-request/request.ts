import jwt from 'jsonwebtoken'
import fetch from 'node-fetch'
import { readPrivateKey } from '../support'
import { PORT } from './config.js'

// Generate JWT
const payload = {
    name: "John Doe", // User information you want to encode
    exp: Math.floor(Date.now() / 1000) + (60 * 60), // Token expiration (1 hour)
}

const token = jwt.sign(payload, readPrivateKey(), { algorithm: 'RS256' })

console.log(`Generated JWT: ${token}\n`)

;(async () => {
    try {
        const response = await fetch(`http://localhost:${PORT}/whoami`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        })

        const data = await response.text()
        console.log('Response:', data)
    } catch (error) {
        console.error('Error:', error)
    }
})();
