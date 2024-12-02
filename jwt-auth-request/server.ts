import express, { Request, Response, NextFunction } from 'express'
import jwt, { JwtPayload } from 'jsonwebtoken'
import { PORT } from './config.js'
import { readPublicKey } from '../support/index.js'

const app = express()

interface UserPayload extends JwtPayload {
    name: string
}

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

    jwt.verify(token, readPublicKey(), { algorithms: ['RS256'], maxAge: '30 d' }, (err, decodedToken) => {
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
