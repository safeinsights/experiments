import express, { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import jwt, { JwtPayload } from 'jsonwebtoken'
import { PORT } from './config.js'

const app = express()

// Load public key
const publicKey: string = fs.readFileSync('public_key.pem', 'utf8')

// Define the structure of the user object (you can adjust it based on the JWT payload structure)
interface UserPayload extends JwtPayload {
    name: string
}

// Extend the Express request type to include the user object
declare global {
    namespace Express {
        interface Request {
            user?: UserPayload
        }
    }
}

// Middleware to validate JWT
function authenticateToken(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]

    if (!token) {
        res.status(401).json({ message: 'Token not found' })
        return
    }

    jwt.verify(token, publicKey, { algorithms: ['RS256'], maxAge: '30 d' }, (err, decodedToken) => {
        if (err) {
            res.status(403).json({ message: 'Invalid token' })
            return
        }

        req.user = decodedToken as UserPayload
        next()
    })
}

app.get('/whoami', authenticateToken, (req: Request, res: Response) => {
    if (!req.user) {
        res.status(401).json({ message: 'User not found' })
        return
    }

    res.send(`Hello ${req.user.name}`)
})

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`)
})
