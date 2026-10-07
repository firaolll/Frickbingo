require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const WEB_APP_URL = String(process.env.WEB_APP_URL || "").trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "").trim();
const PAYMENT_ADDRESS = String(process.env.PAYMENT_ADDRESS || "").trim();
const DATABASE_FILE =
String(process.env.DATABASE_FILE || "frickbingo.db").trim();

const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;

const GAME_STAKES = [10, 20];
const MAX_CARDS = 2;

const WIN_RATE = 0.85;
const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 30;

// ============================================================
// SHARED WINNER CLAIM WINDOW
// ============================================================

const winnerClaimTimers = new Map();

const WINNER_CLAIM_WINDOW_MS = 3000;
// ======================================================
// EXPRESS
// ======================================================

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// DATABASE
// ======================================================

const db = new Database(DATABASE_FILE);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("✅ Database connected");

// ======================================================
// DATABASE TABLES
// ======================================================

db.exec(`
CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
telegram_id TEXT UNIQUE NOT NULL,
username TEXT DEFAULT '',
first_name TEXT DEFAULT '',
balance REAL NOT NULL DEFAULT 0,
play_balance REAL NOT NULL DEFAULT 0,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deposits (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
amount REAL NOT NULL,
reference TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
approved_at DATETIME,

FOREIGN KEY(user_id)  
REFERENCES users(id)

);

CREATE TABLE IF NOT EXISTS withdrawals (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
amount REAL NOT NULL,
account_details TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
approved_at DATETIME,

FOREIGN KEY(user_id)  
REFERENCES users(id)

);

CREATE TABLE IF NOT EXISTS matches (
id INTEGER PRIMARY KEY AUTOINCREMENT,

stake REAL NOT NULL,  

status TEXT NOT NULL DEFAULT 'WAITING',  

prize_pool REAL NOT NULL DEFAULT 0,  

winner_count INTEGER NOT NULL DEFAULT 0,  

paid INTEGER NOT NULL DEFAULT 0,  

created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  

started_at DATETIME,  

finished_at DATETIME

);

CREATE TABLE IF NOT EXISTS games (
id INTEGER PRIMARY KEY AUTOINCREMENT,

match_id INTEGER,  

user_id INTEGER NOT NULL,  

stake REAL NOT NULL,  

cards INTEGER NOT NULL,  

result TEXT DEFAULT 'STARTED',  

prize REAL NOT NULL DEFAULT 0,  

card_number INTEGER,  

status TEXT NOT NULL DEFAULT 'STARTED',  

play_spent REAL NOT NULL DEFAULT 0,  

main_spent REAL NOT NULL DEFAULT 0,  

created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  

finished_at DATETIME,  

FOREIGN KEY(user_id)  
REFERENCES users(id),  

FOREIGN KEY(match_id) REFERENCES matches(id)

);
`);
try {
    db.exec(`
        ALTER TABLE games
        ADD COLUMN winner_card_number INTEGER
    `);
} catch (error) {
    // Column already exists; no action needed.
}
// ======================================================
// MIGRATION HELPER
// ======================================================

function addColumnIfMissing(table, column, definition) {
const columns = db
.prepare(`PRAGMA table_info(${table})`)
.all();

const exists = columns.some(  
    c => c.name === column  
);  

if (!exists) {  
    db.exec(`  
        ALTER TABLE ${table}  
        ADD COLUMN ${column} ${definition}  
    `);  

    console.log(  
        `✅ Added column ${table}.${column}`  
    );  
}
}

// ======================================================
// OLD DATABASE COMPATIBILITY
// ======================================================

addColumnIfMissing(
"games",
"match_id",
"INTEGER"
);

addColumnIfMissing(
"games",
"play_spent", 
"REAL NOT NULL DEFAULT 0"
);

addColumnIfMissing(
"games",
"main_spent",
"REAL NOT NULL DEFAULT 0"
);
addColumnIfMissing(
    "games",
    "card_numbers",
    "TEXT NOT NULL DEFAULT '[]'"
);
addColumnIfMissing(
"withdrawals",
"telegram_id",
"TEXT"
);

addColumnIfMissing(
"withdrawals",
"account_details",
"TEXT"
);
addColumnIfMissing(
"matches",
"countdown_started_at",
"DATETIME"
);

addColumnIfMissing(
"matches",
"countdown_seconds",
"INTEGER NOT NULL DEFAULT 30"
);

addColumnIfMissing(
"matches",
"called_balls",
"TEXT DEFAULT '[]'"
);

addColumnIfMissing(
"matches",
"current_ball",
"TEXT DEFAULT ''"
);

// ======================================================
// HELPERS
// ======================================================

function num(value) {
const n = Number(value);

if (!Number.isFinite(n)) {  
    return 0;  
}  

return Math.round(  
    n * 100  
) / 100;

}

function integer(value) {
const n = Number(value);

if (!Number.isInteger(n)) {  
    return null;  
}  

return n;

}

function validStake(stake) {
return GAME_STAKES.includes(
Number(stake)
);
}

function validCards(cards) {
return (
Number.isInteger(Number(cards)) &&
Number(cards) >= 1 &&
Number(cards) <= MAX_CARDS
);

}
// ======================================================
// FIND WAITING MATCH
// ======================================================
function findActiveMatch(stake) {

    return db.prepare(`
        SELECT *
        FROM matches
        WHERE stake = ?
          AND status IN ('WAITING', 'PLAYING')
        ORDER BY
            CASE
                WHEN status = 'WAITING' THEN 0
                WHEN status = 'PLAYING' THEN 1
            END,
            id ASC
        LIMIT 1
    `).get(stake);

}
// ======================================================
// GET MATCH COUNTDOWN
// ======================================================

function getMatchCountdown(match) {

    if (!match.countdown_started_at) {
        return COUNTDOWN_SECONDS;
    }

    const started =
        new Date(
            match.countdown_started_at + "Z"
        ).getTime();

    const elapsed =
        Math.floor(
            (Date.now() - started) / 1000
        );

    return Math.max(
        0,
        COUNTDOWN_SECONDS - elapsed
    );

}

// ============================================================
// SERVER-GENERATED BINGO CARDS
// ============================================================

try {

    db.exec(`
        ALTER TABLE games
        ADD COLUMN generated_cards TEXT DEFAULT '{}'
    `);

    console.log(
        "✅ Added generated_cards column to games"
    );

} catch(error) {

    if (
        !String(error.message)
            .toLowerCase()
            .includes("duplicate column")
    ) {

        console.error(
            "❌ generated_cards migration error:",
            error
        );

    }

}
// ======================================================
// PROCESS WAITING MATCHES
// ======================================================

function processWaitingMatches() {

    try {

        const waitingMatches =
            db.prepare(`
                SELECT *
                FROM matches
                WHERE status = 'WAITING'
                  AND countdown_started_at IS NOT NULL
            `).all();


        for (const match of waitingMatches) {

            const playerCount =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM games
                    WHERE match_id = ?
                `).get(
                    match.id
                ).count;


            const countdown =
                getMatchCountdown(match);


            // Countdown still running
            if (countdown > 0) {
                continue;
            }


            // ==================================================
            // ENOUGH PLAYERS → START MATCH
            // ==================================================

            if (playerCount >= MIN_PLAYERS) {

                const result =
                    db.prepare(`
                        UPDATE matches
                        SET
                            status = 'PLAYING',
                            started_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                          AND status = 'WAITING'
                    `).run(
                        match.id
                    );


                if (result.changes === 1) {

                    db.prepare(`
    UPDATE games
    SET status = 'PLAYING'
    WHERE match_id = ?
      AND status = 'WAITING'
`).run(
    match.id
);


                    console.log(
                        `🎮 Match ${match.id} STARTED with ${playerCount} players`
                    );

                }

            }

            // ==================================================
            // NOT ENOUGH PLAYERS → WAIT FOR MORE
            // ==================================================

            else {

                db.prepare(`
                    UPDATE matches
                    SET
                        countdown_started_at =
                            CURRENT_TIMESTAMP,
                        countdown_seconds = ?,
                        status = 'WAITING'
                    WHERE id = ?
                      AND status = 'WAITING'
                `).run(
                    COUNTDOWN_SECONDS,
                    match.id
                );


                console.log(
                    `⏳ Match ${match.id}: only ${playerCount} player(s). Countdown restarted.`
                );

            }

        }

    } catch (error) {

        console.error(
            "❌ MATCH PROCESSOR ERROR:",
            error
        );

    }

}


// ======================================================
// RUN MATCH PROCESSOR EVERY SECOND
// ======================================================

setInterval(
    () => {
        processWaitingMatches();
    },
    1000
);


// ======================================================
// SERVER-CONTROLLED BINGO BALL CALLING
// ======================================================
function processPlayingMatches(){

    try{

        const playingMatches =
            db.prepare(`
                SELECT
                    id,
                    called_balls,
                    current_ball
                FROM matches
                WHERE status = 'PLAYING'
            `).all();


        for(const match of playingMatches){

            // ====================================================
            // MATCH ID
            // ====================================================

            const matchId = Number(match.id);


            // ====================================================
            // LOAD CALLED BALLS
            // ====================================================

            let calledBalls = [];

            try{

                calledBalls =
                    match.called_balls
                        ? JSON.parse(match.called_balls)
                        : [];

            }catch(error){

                console.error(
                    "❌ INVALID CALLED BALLS:",
                    {
                        matchId,
                        calledBalls:
                            match.called_balls
                    }
                );

                calledBalls = [];

            }


            if(!Array.isArray(calledBalls)){
                calledBalls = [];
            }


            calledBalls =
                calledBalls
                    .map(Number)
                    .filter(
                        number =>
                            Number.isInteger(number) &&
                            number >= 1 &&
                            number <= 75
                    );


            // ====================================================
            // FIND AVAILABLE BALLS
            // ====================================================

            const available = [];

            for(
                let number = 1;
                number <= 75;
                number++
            ){

                if(
                    !calledBalls.includes(number)
                ){

                    available.push(number);

                }

            }


            // ====================================================
            // DO NOT FINISH AT 75
            // ====================================================

            if(available.length === 0){

                console.warn(
                    "⚠️ ALL 75 BALLS CALLED:",
                    {
                        matchId,
                        calledCount:
                            calledBalls.length
                    }
                );

                continue;

            }


            // ====================================================
            // SELECT NEXT BALL
            // ====================================================

            const index =
                Math.floor(
                    Math.random() *
                    available.length
                );


            const number =
                available[index];


            calledBalls.push(number);


            console.log(
                `🎱 SERVER MATCH ${matchId}: CALLED ${number}`
            );


            // ====================================================
            // CHECK ALL PLAYERS FOR WINNER
            // ====================================================

            let serverWinnerFound = false;


            const activeGames =
                db.prepare(`
                    SELECT
                        id,
                        user_id,
                        card_numbers,
                        status
                    FROM games
                    WHERE match_id = ?
                    AND status = 'PLAYING'
                `).all(matchId);


            for(const game of activeGames){

                let playerCards = [];


                try{

                    playerCards =
                        game.card_numbers
                            ? JSON.parse(
                                game.card_numbers
                              )
                            : [];

                }catch(error){

                    console.error(
                        "❌ INVALID PLAYER CARDS:",
                        {
                            gameId: game.id,
                            cardNumbers:
                                game.card_numbers
                        }
                    );

                    playerCards = [];

                }


                if(!Array.isArray(playerCards)){
                    playerCards = [];
                }


                playerCards =
                    playerCards
                        .map(Number)
                        .filter(
                            cardNumber =>
                                Number.isInteger(
                                    cardNumber
                                ) &&
                                cardNumber >= 1 &&
                                cardNumber <= 200
                        );


                for(
                    const cardNumber
                    of playerCards
                ){

                    const card =
                        generateServerBingoNumbers(
                            cardNumber
                        );


                    const won =
                        isServerWinningCard(
                            card,
                            calledBalls
                        );


                    if(won){

                        console.log(
                            "🏆 SERVER DETECTED WINNER:",
                            {
                                matchId,
                                gameId: game.id,
                                userId: game.user_id,
                                cardNumber,
                                calledCount:
                                    calledBalls.length
                            }
                        );


                        serverWinnerFound = true;

                        break;

                    }

                }


                if(serverWinnerFound){
                    break;
                }

            }


            // ====================================================
            // WINNER FOUND
            // STOP BALL CALLING
            // ENTER CLAIM WINDOW
            // ====================================================

            if(serverWinnerFound){

                const result =
                    db.prepare(`
                        UPDATE matches
                        SET
                            called_balls = ?,
                            current_ball = ?,
                            status = 'CLAIM_WINDOW'
                        WHERE id = ?
                        AND status = 'PLAYING'
                    `).run(
                        JSON.stringify(
                            calledBalls
                        ),
                        number,
                        matchId
                    );


                if(result.changes === 1){

                    console.log(
                        "🛑 SERVER ENTERED CLAIM WINDOW:",
                        {
                            matchId,
                            currentBall: number,
                            calledCount:
                                calledBalls.length
                        }
                    );

                }


                // Do NOT process this match again
                // during this timer cycle.
                continue;

            }


            // ====================================================
            // NO WINNER
            // SAVE BALL
            // ====================================================

            const result =
                db.prepare(`
                    UPDATE matches
                    SET
                        called_balls = ?,
                        current_ball = ?
                    WHERE id = ?
                    AND status = 'PLAYING'
                `).run(
                    JSON.stringify(
                        calledBalls
                    ),
                    number,
                    matchId
                );


            if(result.changes === 1){

                console.log(
                    `✅ MATCH ${matchId} SAVED BALL ${number} — TOTAL ${calledBalls.length}`
                );

            }else{

                console.warn(
                    "⚠️ BALL SAVE FAILED:",
                    {
                        matchId,
                        number
                    }
                );

            }

        }


    }catch(error){

        console.error(
            "❌ SERVER BALL CALLING ERROR:",
            error
        );

    }

}


// ========================================================
// GENERATE NEXT BALL EVERY 3 SECONDS
// ========================================================

setInterval(
    processPlayingMatches,
    3000
);
// ======================================================
// TELEGRAM INIT DATA
// ======================================================

function verifyTelegramInitData(initData) {

if (!BOT_TOKEN) {  
    throw new Error(  
        "BOT_TOKEN is not configured"  
    );  
}  

if (!initData) {  
    throw new Error(  
        "Telegram authentication data missing"  
    );  
}  

const params = new URLSearchParams(  
    initData  
);  

const hash = params.get("hash");  

if (!hash) {  
    throw new Error(  
        "Telegram hash missing"  
    );  
}  

params.delete("hash");  

const dataCheckString =  
    [...params.entries()]  
        .sort(  
            ([a], [b]) =>  
                a.localeCompare(b)  
        )  
        .map(  
            ([key, value]) =>  
                `${key}=${value}`  
        )  
        .join("\n");  

const secretKey =  
    crypto  
        .createHmac(  
            "sha256",  
            "WebAppData"  
        )  
        .update(BOT_TOKEN)  
        .digest();  

const calculatedHash =  
    crypto  
        .createHmac(  
            "sha256",  
            secretKey  
        )  
        .update(dataCheckString)  
        .digest("hex");  

if (  
    calculatedHash.length !==  
    hash.length  
) {  
    throw new Error(  
        "Invalid Telegram authentication"  
    );  
}  

if (  
    !crypto.timingSafeEqual(  
        Buffer.from(calculatedHash),  
        Buffer.from(hash)  
    )  
) {  
    throw new Error(  
        "Invalid Telegram authentication"  
    );  
}  

const userString =  
    params.get("user");  

if (!userString) {  
    throw new Error(  
        "Telegram user missing"  
    );  
}  

return JSON.parse(  
    userString  
);

}

// ======================================================
// GET TELEGRAM USER
// ======================================================

function getTelegramUser(req) {

const initData =  
    req.headers[  
        "x-telegram-init-data"  
    ];  

return verifyTelegramInitData(  
    initData  
);

}

// ======================================================
// FIND / CREATE USER
// ======================================================

function getOrCreateUser(
telegramUser
) {

const telegramId =  
    String(  
        telegramUser.id  
    );  

let user =  
    db.prepare(`  
        SELECT *  
        FROM users  
        WHERE telegram_id = ?  
    `).get(  
        telegramId  
    );  

if (!user) {  

    db.prepare(`  
        INSERT INTO users (  
            telegram_id,  
            username,  
            first_name  
        )  
        VALUES (?, ?, ?)  
    `).run(  
        telegramId,  
        telegramUser.username || "",  
        telegramUser.first_name || ""  
    );  

    user =  
        db.prepare(`  
            SELECT *  
            FROM users  
            WHERE telegram_id = ?  
        `).get(  
            telegramId  
        );  

} else {  

    db.prepare(`  
        UPDATE users  

        SET username = ?,  
            first_name = ?  

        WHERE id = ?  
    `).run(  
        telegramUser.username || "",  
        telegramUser.first_name || "",  
        user.id  
    );  

    user =  
        db.prepare(`  
            SELECT *  
            FROM users  
            WHERE id = ?  
        `).get(  
            user.id  
        );  
}  

return user;

}

// ======================================================
// AUTH MIDDLEWARE
// ======================================================

function auth(req, res, next) {

try {  

    const telegramUser =  
        getTelegramUser(req);  
    console.log("AUTH TELEGRAM USER:", telegramUser);
    const user =  
        getOrCreateUser(  
            telegramUser  
        );  

    req.telegramUser =  
        telegramUser;  

    req.user =  
        user;  

    next();  

} catch (error) {  

    console.error(  
        "AUTH ERROR:",  
        error.message  
    );  

    res.status(401).json({  
        success: false,  
        error:  
            error.message ||  
            "Unauthorized"  
    });  
}
}

// ======================================================
// HEALTH
// ======================================================

app.get(
"/api/health",
(req, res) => {

res.json({  
        success: true,  
        status: "OK",  
        database: "connected",  
        time: new Date().toISOString()  
    });  

}

);

// ======================================================
// CURRENT USER
// ======================================================

app.get(
"/api/me",
auth,
(req, res) => {

const user =  
        db.prepare(`  
            SELECT  
                id,  
                telegram_id,  
                username,  
                first_name,  
                balance,  
                play_balance,  
                created_at  
            FROM users  
            WHERE id = ?  
        `).get(  
            req.user.id  
        );  

    res.json({  
        success: true,  
        user  
    });  

}

);

// ======================================================
// BALANCE
// ======================================================

app.get(
"/api/balance",
auth,
(req, res) => {

const user =  
        db.prepare(`  
            SELECT  
                balance,  
                play_balance  
            FROM users  
            WHERE id = ?  
        `).get(  
            req.user.id  
        );  

    res.json({  
        success: true,  

        mainBalance:  
            num(user.balance),  

        playBalance:  
            num(user.play_balance),  

        balance:  
            num(user.balance),  

        play_balance:  
            num(user.play_balance)  
    });  

}

);

// ======================================================
// HISTORY
// ======================================================
app.get(
    "/api/history",
    auth,
    (req, res) => {

        try{

            const rows =
                db.prepare(`
                    SELECT
                        g.id,
                        g.match_id,
                        g.stake,
                        g.cards,
                        g.result,
                        g.prize,
                        g.status,
                        g.created_at,
                        g.finished_at
                    FROM games g
                    WHERE g.user_id = ?
                    ORDER BY g.id DESC
                    LIMIT 100
                `).all(
                    req.user.id
                );

            console.log(
                "📜 HISTORY USER:",
                req.user.id
            );

            console.log(
                "📜 HISTORY ROWS:",
                rows
            );

            res.json({
                success: true,
                history: rows
            });

        }catch(error){

            console.error(
                "❌ HISTORY ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);
// ======================================================
// SCORE / TOP 10
// ======================================================

app.get(
"/api/score",
(req, res) => {

const rows =  
        db.prepare(`  
            SELECT  
                u.id,  
                u.telegram_id,  
                u.username,  
                u.first_name,  

                COUNT(  
                    CASE  
                        WHEN g.result = 'WIN'  
                        THEN 1  
                    END  
                ) AS wins,  

                COALESCE(  
                    SUM(  
                        CASE  
                            WHEN g.result = 'WIN'  
                            THEN g.prize  
                            ELSE 0  
                        END  
                    ),  
                    0  
                ) AS total_prize  

            FROM users u  

            LEFT JOIN games g  
                ON g.user_id = u.id  

            GROUP BY u.id  

            ORDER BY wins DESC,  
                     total_prize DESC  

            LIMIT 10  
        `).all();  

    res.json({  
        success: true,  
        players: rows  
    });  

}

);


// ============================================================
// SERVER CARD ASSIGNMENT
// The client does NOT choose card numbers.
// The server chooses them.
// ============================================================

function generateRandomCardNumbers(
    count,
    excludedNumbers = []
){

    const excluded =
        new Set(
            excludedNumbers.map(Number)
        );

    const available = [];

    for(let n = 1; n <= 200; n++){

        if(!excluded.has(n)){
            available.push(n);
        }

    }

    // Shuffle available card numbers
    for(
        let i = available.length - 1;
        i > 0;
        i--
    ){

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            available[i],
            available[j]
        ] =
        [
            available[j],
            available[i]
        ];

    }

    return available.slice(
        0,
        count
    );
}
// ======================================================
// CREATE MATCH
// ======================================================
app.post("/api/match/create", auth, (req, res) => {

    try {

        // ============================================================
        // BASIC INPUT
        // ============================================================

        const stake =
            num(req.body.stake);

        const cards =
            Number(req.body.cards);

        console.log(
            "🎴 MATCH CARD REQUEST:",
            {
                bodyCards: req.body.cards,
                parsedCards: cards
            }
        );


        // ============================================================
        // VALIDATE STAKE
        // ============================================================

        if (!validStake(stake)) {

            return res.status(400).json({
                success: false,
                error: "Invalid stake"
            });

        }


        // ============================================================
        // VALIDATE CARD COUNT
        // ============================================================

        if (
            !Number.isInteger(cards) ||
            cards < 0 ||
            cards > MAX_CARDS
        ) {

            return res.status(400).json({
                success: false,
                error: "Invalid number of cards"
            });

        }


        const userId =
            req.user.id;


        // ============================================================
        // FIND OR CREATE ACTIVE MATCH
        // ============================================================

        let match =
            findActiveMatch(stake);


        if (!match) {

            const result =
                db.prepare(`
                    INSERT INTO matches (
                        stake,
                        status,
                        countdown_started_at,
                        countdown_seconds,
                        called_balls,
                        current_ball
                    )
                    VALUES (
                        ?,
                        'WAITING',
                        CURRENT_TIMESTAMP,
                        ?,
                        '[]',
                        ''
                    )
                `).run(
                    stake,
                    COUNTDOWN_SECONDS
                );


            match =
                db.prepare(`
                    SELECT *
                    FROM matches
                    WHERE id = ?
                `).get(
                    Number(
                        result.lastInsertRowid
                    )
                );

        }


        const matchId =
            Number(match.id);


        // ============================================================
        // CHECK EXISTING PLAYER GAME
        // ============================================================

        let existingGame =
            db.prepare(`
                SELECT *
                FROM games
                WHERE match_id = ?
                  AND user_id = ?
                LIMIT 1
            `).get(
                matchId,
                userId
            );


        // ============================================================
        // NEW PLAYER
        // ============================================================

        if (!existingGame) {

            const user =
                db.prepare(`
                    SELECT
                        balance,
                        play_balance
                    FROM users
                    WHERE id = ?
                `).get(userId);


            if (!user) {

                return res.status(404).json({
                    success: false,
                    error: "User not found"
                });

            }


            // ========================================================
            // SERVER ASSIGNS CARD NUMBERS
            // ========================================================

           // ============================================================
// USE PLAYER-REQUESTED CARD NUMBERS
// SERVER VALIDATES THEM
// ============================================================

const requestedCardNumbers =
    Array.isArray(req.body.cardNumbers)
        ? req.body.cardNumbers
            .map(Number)
            .filter(
                n =>
                    Number.isInteger(n) &&
                    n >= 1 &&
                    n <= 200
            )
        : [];


if(
    requestedCardNumbers.length !== cards
){

    return res.status(400).json({

        success: false,

        error:
            "Invalid card selection."

    });

}


const cardNumbers =
    requestedCardNumbers;


console.log(
    "🎴 PLAYER REQUESTED CARDS:",
    {
        userId,
        matchId,
        cards,
        cardNumbers
    }
);
            // ========================================================
            // CALCULATE COST
            // ========================================================

            const cost =
                num(
                    stake * cards
                );


            const totalBalance =
                num(
                    Number(user.balance || 0) +
                    Number(user.play_balance || 0)
                );


            if (totalBalance < cost) {

                return res.status(400).json({
                    success: false,
                    error: "Insufficient balance",
                    required: cost,
                    mainBalance:
                        num(user.balance),
                    playBalance:
                        num(user.play_balance)
                });

            }


            // ========================================================
            // PLAY BALANCE FIRST
            // ========================================================

            const playSpent =
                Math.min(
                    Number(user.play_balance || 0),
                    cost
                );


            const mainSpent =
                num(
                    cost - playSpent
                );


            // ========================================================
            // TRANSACTION
            // ========================================================

            const transaction =
                db.transaction(() => {

                    const updateBalance =
                        db.prepare(`
                            UPDATE users
                            SET
                                balance =
                                    balance - ?,

                                play_balance =
                                    play_balance - ?

                            WHERE id = ?

                            AND balance >= ?

                            AND play_balance >= ?
                        `).run(
                            mainSpent,
                            playSpent,
                            userId,
                            mainSpent,
                            playSpent
                        );


                    if (
                        updateBalance.changes !== 1
                    ) {

                        throw new Error(
                            "Balance changed. Please try again."
                        );

                    }


                    // =================================================
                    // GENERATE SERVER CARDS
                    // =================================================

                    const generatedCards =
                        generateServerCards(
                            cardNumbers
                        );


                    console.log(
                        "🎴 SERVER GENERATED CARDS:",
                        {
                            userId,
                            matchId,
                            cardNumbers,
                            generatedCards
                        }
                    );


                    // =================================================
                    // CREATE GAME
                    // =================================================

                    db.prepare(`
                        INSERT INTO games (
                            match_id,
                            user_id,
                            stake,
                            cards,
                            card_numbers,
                            generated_cards,
                            result,
                            prize,
                            status,
                            play_spent,
                            main_spent
                        )
                        VALUES (
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            'WAITING',
                            0,
                            'WAITING',
                            ?,
                            ?
                        )
                    `).run(
                        matchId,
                        userId,
                        stake,
                        cards,
                        JSON.stringify(
                            cardNumbers
                        ),
                        JSON.stringify(
                            generatedCards
                        ),
                        playSpent,
                        mainSpent
                    );

                });


            transaction();

        }


        // ============================================================
        // EXISTING PLAYER
        // ============================================================

        else {

            const oldCards =
                Number(
                    existingGame.cards || 0
                );


            const newCards =
                Number(cards);


            const cardDifference =
                newCards - oldCards;


            // ========================================================
            // REMOVE CARDS
            // ========================================================

            if (cardDifference < 0) {

                const removedCards =
                    Math.abs(
                        cardDifference
                    );


                const refund =
                    num(
                        stake * removedCards
                    );


                const oldPlaySpent =
                    Number(
                        existingGame.play_spent || 0
                    );


                const oldMainSpent =
                    Number(
                        existingGame.main_spent || 0
                    );


                // ====================================================
                // REFUND USING ORIGINAL SPENDING SOURCE
                // ====================================================

                const playRefund =
                    Math.min(
                        oldPlaySpent,
                        refund
                    );


                const mainRefund =
                    num(
                        refund - playRefund
                    );


                // ====================================================
                // GET SERVER CARD NUMBERS
                // ====================================================

                let oldCardNumbers = [];

                try {

                    oldCardNumbers =
                        existingGame.card_numbers
                            ? JSON.parse(
                                existingGame.card_numbers
                            )
                            : [];

                } catch(error) {

                    oldCardNumbers = [];

                }


                if (
                    !Array.isArray(
                        oldCardNumbers
                    )
                ) {

                    oldCardNumbers = [];

                }


                oldCardNumbers =
                    oldCardNumbers
                        .map(Number)
                        .filter(
                            n =>
                                Number.isInteger(n) &&
                                n >= 1 &&
                                n <= 200
                        );


                // ====================================================
                // KEEP ONLY REMAINING SERVER CARDS
                // ====================================================

                const updatedCardNumbers =
                    oldCardNumbers.slice(
                        0,
                        newCards
                    );


                const generatedCards =
                    generateServerCards(
                        updatedCardNumbers
                    );


                console.log(
                    "🎴 SERVER REMOVED CARD:",
                    {
                        userId,
                        matchId,
                        oldCardNumbers,
                        updatedCardNumbers,
                        generatedCards
                    }
                );


                // ====================================================
                // REFUND + UPDATE GAME
                // ====================================================

                const transaction =
                    db.transaction(() => {

                        const refundResult =
                            db.prepare(`
                                UPDATE users
                                SET
                                    play_balance =
                                        COALESCE(
                                            play_balance,
                                            0
                                        ) + ?,

                                    balance =
                                        COALESCE(
                                            balance,
                                            0
                                        ) + ?

                                WHERE id = ?
                            `).run(
                                playRefund,
                                mainRefund,
                                userId
                            );


                        if (
                            refundResult.changes !== 1
                        ) {

                            throw new Error(
                                "Failed to refund card cost."
                            );

                        }


                        // =================================================
                        // UPDATE GAME
                        // =================================================

                        db.prepare(`
                            UPDATE games
                            SET
                                cards = ?,

                                card_numbers = ?,

                                generated_cards = ?,

                                play_spent =
                                    MAX(
                                        0,
                                        COALESCE(
                                            play_spent,
                                            0
                                        ) - ?
                                    ),

                                main_spent =
                                    MAX(
                                        0,
                                        COALESCE(
                                            main_spent,
                                            0
                                        ) - ?

                                    )

                            WHERE id = ?

                            AND user_id = ?
                        `).run(
                            newCards,

                            JSON.stringify(
                                updatedCardNumbers
                            ),

                            JSON.stringify(
                                generatedCards
                            ),

                            playRefund,

                            mainRefund,

                            existingGame.id,

                            userId
                        );

                    });


                transaction();


                console.log(
                    "💰 CARD REMOVAL REFUND:",
                    {
                        oldCards,
                        newCards,
                        removedCards,
                        refund,
                        playRefund,
                        mainRefund,
                        latestCards:
                            updatedCardNumbers
                    }
                );

            }


            // ========================================================
            // ADD CARDS
            // ========================================================

            else if (cardDifference > 0) {

                const additionalCards =
                    cardDifference;


                const additionalCost =
                    num(
                        stake *
                        additionalCards
                    );


                const user =
                    db.prepare(`
                        SELECT
                            balance,
                            play_balance
                        FROM users
                        WHERE id = ?
                    `).get(userId);


                if (!user) {

                    return res.status(404).json({
                        success: false,
                        error: "User not found"
                    });

                }


                const totalBalance =
                    num(
                        Number(
                            user.balance || 0
                        ) +
                        Number(
                            user.play_balance || 0
                        )
                    );


                if (
                    totalBalance <
                    additionalCost
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Insufficient balance for additional card",

                        required:
                            additionalCost,

                        mainBalance:
                            num(
                                user.balance
                            ),

                        playBalance:
                            num(
                                user.play_balance
                            )

                    });

                }


                // ====================================================
                // PLAY BALANCE FIRST
                // ====================================================

                const additionalPlaySpent =
                    Math.min(
                        Number(
                            user.play_balance || 0
                        ),
                        additionalCost
                    );


                const additionalMainSpent =
                    num(
                        additionalCost -
                        additionalPlaySpent
                    );


                // ====================================================
                // TRANSACTION
                // ====================================================

                const transaction =
                    db.transaction(() => {

                        const updateBalance =
                            db.prepare(`
                                UPDATE users
                                SET
                                    balance =
                                        balance - ?,

                                    play_balance =
                                        play_balance - ?

                                WHERE id = ?

                                AND balance >= ?

                                AND play_balance >= ?
                            `).run(
                                additionalMainSpent,
                                additionalPlaySpent,
                                userId,
                                additionalMainSpent,
                                additionalPlaySpent
                            );


                        if (
                            updateBalance.changes !== 1
                        ) {

                            throw new Error(
                                "Balance changed. Please try again."
                            );

                        }


                        // =============================================
                        // GET OLD SERVER CARD NUMBERS
                        // =============================================

                        let oldCardNumbers = [];


                        try {

                            oldCardNumbers =
                                existingGame.card_numbers
                                    ? JSON.parse(
                                        existingGame.card_numbers
                                    )
                                    : [];

                        } catch(error) {

                            oldCardNumbers = [];

                        }


                        if (
                            !Array.isArray(
                                oldCardNumbers
                            )
                        ) {

                            oldCardNumbers = [];

                        }


                        oldCardNumbers =
                            oldCardNumbers
                                .map(Number)
                                .filter(
                                    n =>
                                        Number.isInteger(n) &&
                                        n >= 1 &&
                                        n <= 200
                                );


                        // =============================================
                        // GENERATE ONLY NEW SERVER CARDS
                        // =============================================
// ============================================================
// ADD PLAYER-REQUESTED NEW CARDS
// ============================================================

const requestedCardNumbers =
    Array.isArray(req.body.cardNumbers)
        ? req.body.cardNumbers
            .map(Number)
            .filter(
                n =>
                    Number.isInteger(n) &&
                    n >= 1 &&
                    n <= 200
            )
        : [];


const newCardNumbers =
    requestedCardNumbers.filter(
        number =>
            !oldCardNumbers.includes(number)
    );


if(
    newCardNumbers.length !==
    additionalCards
){

    return res.status(400).json({

        success: false,

        error:
            "Invalid additional card selection."

    });

}


const updatedCardNumbers = [
    ...oldCardNumbers,
    ...newCardNumbers
];


console.log(
    "🎴 ADDITIONAL PLAYER CARDS:",
    {
        userId,
        matchId,
        oldCardNumbers,
        requestedCardNumbers,
        newCardNumbers,
        updatedCardNumbers
    }
);


                        // =============================================
                        // GENERATE ALL CARDS
                        // =============================================

                        const generatedCards =
                            generateServerCards(
                                updatedCardNumbers
                            );


                        console.log(
                            "🎴 SERVER ADDED CARDS:",
                            {
                                userId,
                                matchId,
                                oldCardNumbers,
                                newCardNumbers,
                                updatedCardNumbers,
                                generatedCards
                            }
                        );


                        // =============================================
                        // UPDATE GAME
                        // =============================================

                        db.prepare(`
                            UPDATE games
                            SET
                                cards = ?,

                                card_numbers = ?,

                                generated_cards = ?,

                                play_spent =
                                    COALESCE(
                                        play_spent,
                                        0
                                    ) + ?,

                                main_spent =
                                    COALESCE(
                                        main_spent,
                                        0
                                    ) + ?

                            WHERE id = ?

                            AND user_id = ?
                        `).run(
                            newCards,

                            JSON.stringify(
                                updatedCardNumbers
                            ),

                            JSON.stringify(
                                generatedCards
                            ),

                            additionalPlaySpent,

                            additionalMainSpent,

                            existingGame.id,

                            userId
                        );

                    });


                transaction();


                console.log(
                    "💳 ADDITIONAL CARD CHARGE:",
                    {
                        oldCards,
                        newCards,
                        additionalCards,
                        additionalCost,
                        additionalPlaySpent,
                        additionalMainSpent,
                        latestCards:
                            (() => {

                                try {

                                    const latest =
                                        db.prepare(`
                                            SELECT
                                                card_numbers
                                            FROM games
                                            WHERE id = ?
                                        `).get(
                                            existingGame.id
                                        );

                                    return latest?.card_numbers
                                        ? JSON.parse(
                                            latest.card_numbers
                                        )
                                        : [];

                                } catch(error) {

                                    return [];

                                }

                            })()
                    }
                );

            }


            // ========================================================
            // SAME NUMBER OF CARDS
            // ========================================================

            else {

                console.log(
                    "🎫 SAME CARD COUNT — KEEP SERVER CARDS:",
                    {
                        gameId:
                            existingGame.id,

                        cards:
                            newCards,

                        existingCardNumbers:
                            existingGame.card_numbers
                    }
                );

            }

        }


        // ============================================================
        // GET PLAYER COUNT
        // ============================================================

        const playerCount =
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM games
                WHERE match_id = ?
                  AND status = 'WAITING'
            `).get(matchId).count;


        // ============================================================
        // GET UPDATED MATCH
        // ============================================================

        const updatedMatch =
            db.prepare(`
                SELECT *
                FROM matches
                WHERE id = ?
            `).get(matchId);


        // ============================================================
        // GET PLAYER GAME
        // ============================================================

        const playerGame =
            db.prepare(`
                SELECT
                    id,
                    card_numbers,
                    generated_cards
                FROM games
                WHERE match_id = ?
                  AND user_id = ?
                ORDER BY id DESC
                LIMIT 1
            `).get(
                matchId,
                userId
            );


        // ============================================================
        // READ GENERATED CARDS
        // ============================================================

        let generatedCards = {};

        try {

            generatedCards =
                playerGame?.generated_cards
                    ? JSON.parse(
                        playerGame.generated_cards
                    )
                    : {};

        } catch(error) {

            generatedCards = {};

        }


        // ============================================================
        // READ SERVER CARD NUMBERS
        // ============================================================

        let playerCardNumbers = [];

        try {

            playerCardNumbers =
                playerGame?.card_numbers
                    ? JSON.parse(
                        playerGame.card_numbers
                    )
                    : [];

        } catch(error) {

            playerCardNumbers = [];

        }


        if (
            !Array.isArray(
                playerCardNumbers
            )
        ) {

            playerCardNumbers = [];

        }


        // ============================================================
        // FINAL RESPONSE
        // ============================================================

        return res.json({

            success: true,

            matchId:
                matchId,

            gameId:
                matchId,

            sharedGameId:
                matchId,

            stake:
                num(
                    updatedMatch.stake
                ),

            status:
                updatedMatch.status,

            playerCount:
                playerCount,

            minPlayers:
                MIN_PLAYERS,

            countdown:
                getMatchCountdown(
                    updatedMatch
                ),

            // IMPORTANT:
            // Return SERVER-ASSIGNED cards
            cardNumbers:
                playerCardNumbers,

            // IMPORTANT:
            // Return exact SERVER-GENERATED cards
            generatedCards:
                generatedCards

        });


    } catch (err) {

        console.error(
            "MATCH CREATE ERROR:",
            err
        );

        return res.status(500).json({

            success: false,

            error:
                "Failed to create/join match"

        });

    }

});
app.get("/api/match/:matchId", auth, (req, res) => {

    try {

        const matchId =
            Number.parseInt(
                req.params.matchId,
                10
            );

        if (
            !Number.isInteger(matchId) ||
            matchId <= 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Invalid match ID"
            });

        }

        const match =
            db.prepare(`
                SELECT *
                FROM matches
                WHERE id = ?
            `).get(
                matchId
            );
            console.log(
    "🔄 MATCH STATUS CHECK:",
    {
        matchId,
        status: match?.status,
        paid: match?.paid,
        winnerCount: match?.winner_count,
        calledBalls: match?.called_balls
            ? JSON.parse(match.called_balls).length
            : 0
    }
);

        if (!match) {

            return res.status(404).json({
                success: false,
                error: "Match not found"
            });

        }
       const players =
    db.prepare(`
        SELECT
            g.id,
            g.user_id,
            g.stake,
            g.cards,
            g.card_numbers,
            g.winner_card_number,
            g.result,
            g.prize,
            g.status,
            u.username,
            u.first_name
        FROM games g
        LEFT JOIN users u
            ON u.id = g.user_id
        WHERE g.match_id = ?
        ORDER BY g.id ASC
    `).all(matchId);

    // ========================================================
// FIND CURRENT WINNERS FROM SHARED MATCH STATE
// ========================================================
// ========================================================
// FIND CURRENT WINNERS FROM SHARED MATCH STATE
// ========================================================

let winnerCards = [];


if (
    String(match.status || "").toUpperCase() ===
    "CLAIM_WINDOW"
) {

    let calledBalls = [];

    try {

        calledBalls =
            match.called_balls
                ? JSON.parse(match.called_balls)
                : [];

    } catch (error) {

        console.error(
            "❌ WINNER BALL JSON ERROR:",
            error
        );

        calledBalls = [];

    }


    if (!Array.isArray(calledBalls)) {

        calledBalls = [];

    }


    calledBalls =
        calledBalls
            .map(Number)
            .filter(
                number =>
                    Number.isInteger(number) &&
                    number >= 1 &&
                    number <= 75
            );


    console.log(
        "🔎 CHECKING SHARED WINNERS:",
        {
            matchId,
            calledCount:
                calledBalls.length
        }
    );


    // ====================================================
    // USE THE ALREADY LOADED players ARRAY
    // ====================================================

    for (const game of players) {

        let cardNumbers = [];

        try {

            cardNumbers =
                game.card_numbers
                    ? JSON.parse(
                        game.card_numbers
                    )
                    : [];

        } catch (error) {

            console.error(
                "❌ PLAYER CARD JSON ERROR:",
                {
                    gameId:
                        game.id,

                    error:
                        error.message
                }
            );

            cardNumbers = [];

        }


        if (!Array.isArray(cardNumbers)) {

            cardNumbers = [];

        }


        cardNumbers =
            cardNumbers
                .map(Number)
                .filter(
                    cardNumber =>
                        Number.isInteger(
                            cardNumber
                        ) &&
                        cardNumber >= 1 &&
                        cardNumber <= 200
                );


        // =================================================
        // CHECK EVERY CARD OF THIS PLAYER
        // =================================================

        for (const cardNumber of cardNumbers) {

            const card =
                generateServerBingoNumbers(
                    cardNumber
                );


            const won =
                isServerWinningCard(
                    card,
                    calledBalls
                );


            if (won) {

                winnerCards.push({

                    gameId:
                        Number(game.id),

                    userId:
                        Number(game.user_id),

                    cardNumber:
                        Number(cardNumber),

                    username:
                        game.username ||
                        null,

                    firstName:
                        game.first_name ||
                        null,

                    prize:
                        Number(
                            game.prize ||
                            0
                        )

                });


                console.log(
                    "🏆 SHARED WINNER FOUND:",
                    {
                        matchId,

                        gameId:
                            game.id,

                        userId:
                            game.user_id,

                        cardNumber
                    }
                );

            }

        }

    }


    console.log(
        "🏆 ALL SHARED WINNERS:",
        winnerCards
    );

}
players.forEach(game => {

    try {

        game.cardNumbers =
            JSON.parse(
                game.card_numbers || "[]"
            );

        if (!Array.isArray(game.cardNumbers)) {
            game.cardNumbers = [];
        }

    } catch (error) {

        game.cardNumbers = [];

    }

});

players.forEach(game => {
    game.winnerCardNumber =
        game.winner_card_number == null
            ? null
            : Number(game.winner_card_number);
});

     const games =
    db.prepare(`
        SELECT
            g.id,
            g.user_id,
            g.stake,
            g.cards,
            g.card_numbers,
            g.status,
            g.result,
            g.prize,
            u.username,
            u.first_name
        FROM games g
        LEFT JOIN users u
            ON u.id = g.user_id
        WHERE g.match_id = ?
        ORDER BY g.id ASC
    `).all(matchId);
        const myGame =
            players.find(
                player =>
                    Number(player.user_id) ===
                    Number(req.user.id)
            ) || null;
const callerUserId =
    players.length > 0
        ? Number(players[0].user_id)
        : null;

const isCaller =
    callerUserId !== null &&
    Number(req.user.id) ===
    callerUserId;

    console.log(
    "🎯 CALLER USER ID:",
    callerUserId
);

console.log(
    "👤 CURRENT USER ID:",
    req.user.id,
    "IS CALLER:",
    isCaller
);
        return res.json({

            success: true,

            match: {

                id:
                    match.id,

                gameId:
                    match.id,

                sharedGameId:
                    match.id,

                stake:
                    num(match.stake),

                status:
                    match.status,

                countdown:
                    getMatchCountdown(match),

                prizePool:
                    num(match.prize_pool),

                winnerCount:
    winnerCards.length ||
    Number(match.winner_count || 0),

winnerCards:
    winnerCards,

paid:
    Boolean(match.paid),
                playerCount:
                    players.length,
                isCaller:
                    isCaller,
                minPlayers:
                    MIN_PLAYERS,

                createdAt:
                    match.created_at,

                startedAt:
                    match.started_at,

                finishedAt:
    match.finished_at,

calledBalls:
    match.called_balls
        ? JSON.parse(match.called_balls)
        : [],

currentBall:
    match.current_ball || null
            },

            players,

            myGame

        });

    } catch (error) {

        console.error(
            "MATCH INFO ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                "Could not load match"

        });

    }

});


app.post("/api/match/:matchId/call",
    auth,
    (req, res) => {

    console.log(
        "📞 SERVER CALL REQUEST — MATCH:",
        req.params.matchId,
        "USER:",
        req.user?.id
    );

    try {

        const matchId =
            Number.parseInt(
                req.params.matchId,
                10
            );

        if (
            !Number.isInteger(matchId) ||
            matchId <= 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Invalid match ID"
            });

        }


        /*
         * ==========================================
         * TRANSACTION
         *
         * Read + generate + save must happen
         * together.
         * ==========================================
         */

        const result =
            db.transaction(() => {

                const match =
                    db.prepare(`
                        SELECT *
                        FROM matches
                        WHERE id = ?
                    `).get(matchId);


                if (!match) {

                    return {
                        type: "ERROR",
                        status: 404,
                        body: {
                            success: false,
                            error: "Match not found"
                        }
                    };

                }
if (
    String(match.status).toUpperCase() ===
    "FINISHED"
) {

    let calledBalls = [];

    try {

        calledBalls =
            match.called_balls
                ? JSON.parse(
                    match.called_balls
                  )
                : [];

    } catch(error) {

        calledBalls = [];

    }


    if(!Array.isArray(calledBalls)) {

        calledBalls = [];

    }


    calledBalls =
        calledBalls
            .map(Number)
            .filter(
                number =>
                    Number.isInteger(number) &&
                    number >= 1 &&
                    number <= 75
            );


    // ========================================================
    // GET ALL WINNING GAMES
    // ========================================================

    const winningGames =
        db.prepare(`
            SELECT
                user_id,
                card_numbers,
                prize,
                status,
                result
            FROM games
            WHERE match_id = ?
            AND status IN ('WIN', 'PAID')
            AND result = 'WIN'
        `).all(match.id);


    // ========================================================
    // FIND WINNING CARD NUMBERS
    // ========================================================

    const winnerCards = [];


    for(const game of winningGames){

        let cards = [];

        try {

            cards =
                game.card_numbers
                    ? JSON.parse(
                        game.card_numbers
                      )
                    : [];

        } catch(error) {

            cards = [];

        }


        if(!Array.isArray(cards)){
            cards = [];
        }


        cards =
            cards
                .map(Number)
                .filter(
                    cardNumber =>
                        Number.isInteger(
                            cardNumber
                        )
                );


        // Check every card belonging to this winner
        for(const cardNumber of cards){

            const card =
                generateServerBingoNumbers(
                    cardNumber
                );


            if(
                isServerWinningCard(
                    card,
                    calledBalls
                )
            ){

                winnerCards.push({
                    userId:
                        Number(game.user_id),

                    cardNumber:
                        Number(cardNumber),

                    prize:
                        Number(game.prize || 0)
                });

            }

        }

    }


    console.log(
        "🏁 FINISHED MATCH RESULT:",
        {
            matchId: match.id,
            winnerCount:
                Number(
                    match.winner_count || 0
                ),
            winnerCards
        }
    );


    return {

        type: "SUCCESS",

        body: {

            success: true,

            matchStatus:
                "FINISHED",

            currentBall:
                match.current_ball
                    ? Number(
                        match.current_ball
                      )
                    : null,

            calledBalls,

            winnerCount:
                Number(
                    match.winner_count || 0
                ),

            winnerCards,

            paid:
                Boolean(match.paid)

        }

    };

}
/*
 * ======================================
 * STOP BALL CALLING DURING CLAIM WINDOW
 * ======================================
 */

const matchStatus =
    String(
        match.status || ""
    ).toUpperCase();


if (
    matchStatus === "CLAIM_WINDOW"
) {

    // ----------------------------------
    // Read existing called balls
    // ----------------------------------

    let calledBalls = [];

    try {

        calledBalls =
            match.called_balls
                ? JSON.parse(
                    match.called_balls
                )
                : [];

    } catch(error) {

        console.error(
            "❌ CLAIM WINDOW BALL PARSE ERROR:",
            error
        );

        calledBalls = [];

    }


    if (!Array.isArray(calledBalls)) {

        calledBalls = [];

    }


    calledBalls =
        calledBalls
            .map(Number)
            .filter(
                number =>
                    Number.isInteger(number) &&
                    number >= 1 &&
                    number <= 75
            );


    console.log(
        "🛑 BALL CALL BLOCKED — CLAIM WINDOW:",
        {
            matchId,
            calledCount:
                calledBalls.length,
            currentBall:
                match.current_ball
                    ? Number(
                        match.current_ball
                    )
                    : null
        }
    );


    return {
        type: "SUCCESS",

        body: {

            success: true,

            stopped: true,

            matchStatus:
                "CLAIM_WINDOW",

            currentBall:
                match.current_ball
                    ? Number(
                        match.current_ball
                    )
                    : null,

            calledBalls

        }
    };

}


/*
 * ======================================
 * MATCH MUST BE PLAYING
 * ======================================
 */

if (
    matchStatus !== "PLAYING"
) {

    return {
        type: "ERROR",

        status: 400,

        body: {

            success: false,

            error:
                "Match is not playing",

            matchStatus:
                match.status

        }

    };

}

                /*
                 * ======================================
                 * READ CURRENT SERVER BALLS
                 * ======================================
                 */

                let calledBalls = [];

                try {

                    calledBalls =
                        match.called_balls
                            ? JSON.parse(
                                match.called_balls
                            )
                            : [];

                } catch(error) {

                    calledBalls = [];

                }


                if (!Array.isArray(calledBalls)) {

                    calledBalls = [];

                }


                calledBalls =
                    calledBalls
                        .map(Number)
                        .filter(
                            number =>
                                Number.isInteger(number) &&
                                number >= 1 &&
                                number <= 75
                        );


                /*
                 * ======================================
                 * FIND AVAILABLE NUMBERS
                 * ======================================
                 */

                const available = [];

                for (
                    let number = 1;
                    number <= 75;
                    number++
                ) {

                    if (
                        !calledBalls.includes(number)
                    ) {

                        available.push(number);

                    }

                }


                if (
                    available.length === 0
                ) {

                    return {
                        type: "SUCCESS",
                        body: {

                            success: true,

                            matchStatus:
                                "PLAYING",

                            currentBall:
                                null,

                            calledBalls

                        }
                    };

                }


                /*
                 * ======================================
                 * GENERATE NEXT BALL
                 * ======================================
                 */

                const index =
                    Math.floor(
                        Math.random() *
                        available.length
                    );

                const number =
                    available[index];


                calledBalls.push(
                    number
                );
/*
 * ======================================
 * SERVER-SIDE WINNER DETECTION
 *
 * Check every player's cards immediately
 * after the new ball is added.
 * ======================================
 */

let serverWinnerFound = false;

const activeGames =
    db.prepare(`
        SELECT
            id,
            user_id,
            card_numbers,
            status
        FROM games
        WHERE match_id = ?
          AND status = 'PLAYING'
    `).all(matchId);


for(const game of activeGames){

    let playerCards = [];

    try{

        playerCards =
            game.card_numbers
                ? JSON.parse(
                    game.card_numbers
                )
                : [];

    }catch(error){

        console.error(
            "❌ SERVER CARD JSON ERROR:",
            {
                gameId: game.id,
                error: error.message
            }
        );

        playerCards = [];

    }


    if(!Array.isArray(playerCards)){
        playerCards = [];
    }


    playerCards =
        playerCards
            .map(Number)
            .filter(
                cardNumber =>
                    Number.isInteger(cardNumber) &&
                    cardNumber >= 1 &&
                    cardNumber <= 200
            );


    for(const cardNumber of playerCards){

        const card =
            generateServerBingoNumbers(
                cardNumber
            );


        const won =
            isServerWinningCard(
                card,
                calledBalls
            );


        if(won){

            console.log(
                "🏆 SERVER DETECTED WINNER:",
                {
                    matchId,
                    gameId: game.id,
                    userId: game.user_id,
                    cardNumber,
                    calledCount:
                        calledBalls.length
                }
            );

            serverWinnerFound = true;

            break;

        }

    }


    if(serverWinnerFound){
        break;
    }

}


/*
 * ======================================
 * SAVE SHARED SERVER STATE
 * ======================================
 */
if (serverWinnerFound) {

    db.prepare(`
        UPDATE matches
        SET
            called_balls = ?,
            current_ball = ?,
            status = 'CLAIM_WINDOW'
        WHERE id = ?
          AND status = 'PLAYING'
    `).run(

        JSON.stringify(
            calledBalls
        ),

        number,

        matchId

    );


    // ========================================================
    // FIND ALL WINNERS AFTER SAVING THE WINNING BALL
    // ========================================================

    const winnerCards = [];


    const winnerGames =
        db.prepare(`
            SELECT
                g.id,
                g.user_id,
                g.card_numbers,
                g.prize,
                u.username,
                u.first_name
            FROM games g
            LEFT JOIN users u
                ON u.id = g.user_id
            WHERE g.match_id = ?
              AND g.status = 'PLAYING'
        `).all(matchId);


    for (const game of winnerGames) {

        let cardNumbers = [];

        try {

            cardNumbers =
                game.card_numbers
                    ? JSON.parse(
                        game.card_numbers
                    )
                    : [];

        } catch (error) {

            cardNumbers = [];

        }


        if (!Array.isArray(cardNumbers)) {
            cardNumbers = [];
        }


        for (const cardNumberRaw of cardNumbers) {

            const cardNumber =
                Number(cardNumberRaw);


            if (
                !Number.isInteger(cardNumber) ||
                cardNumber < 1 ||
                cardNumber > 200
            ) {
                continue;
            }


            const card =
                generateServerBingoNumbers(
                    cardNumber
                );


            const won =
                isServerWinningCard(
                    card,
                    calledBalls
                );


            if (won) {

                winnerCards.push({

                    gameId:
                        Number(game.id),

                    userId:
                        Number(game.user_id),

                    cardNumber:
                        cardNumber,

                    username:
                        game.username || null,

                    firstName:
                        game.first_name || null,

                    prize:
                        Number(
                            game.prize || 0
                        )

                });

            }

        }

    }


    console.log(
        "🏆 SHARED MATCH WINNERS:",
        winnerCards
    );


    return {

        type: "SUCCESS",

        body: {

            success: true,

            stopped: true,

            matchStatus:
                "CLAIM_WINDOW",

            currentBall:
                number,

            calledBalls,

            winnerCount:
                winnerCards.length,

            winnerCards

        }

    };

}
                /*
                 * ======================================
                 * SAVE SHARED SERVER STATE
                 * ======================================
                 */

                db.prepare(`
                    UPDATE matches

                    SET
                        called_balls = ?,
                        current_ball = ?

                    WHERE id = ?

                      AND status = 'PLAYING'
                `).run(

                    JSON.stringify(
                        calledBalls
                    ),

                    number,

                    matchId

                );
/*
 * ======================================
 * ALL 75 NUMBERS CALLED — NO WINNER
 * ======================================
 */

if(
    calledBalls.length >= 75
){

    db.prepare(`
        UPDATE matches

        SET
            status = 'FINISHED',
            current_ball = ?

        WHERE id = ?

          AND status = 'PLAYING'
    `).run(
        number,
        matchId
    );


    console.log(
        "🏁 ALL 75 BALLS CALLED — NO WINNER:",
        {
            matchId,
            calledCount:
                calledBalls.length
        }
    );


    return {
        type: "SUCCESS",

        body: {

            success: true,

            matchStatus:
                "FINISHED",

            currentBall:
                number,

            calledBalls,

            winnerCount: 0,

            paid: false

        }
    };

}

                console.log(
                    "🎱 SERVER CALLED BALL:",
                    number,
                    "MATCH:",
                    matchId,
                    "TOTAL CALLED:",
                    calledBalls.length
                );


                /*
                 * ======================================
                 * RETURN EXACT SERVER STATE
                 * ======================================
                 */

                return {
                    type: "SUCCESS",
                    body: {

                        success: true,

                        matchStatus:
                            "PLAYING",

                        currentBall:
                            number,

                        calledBalls

                    }
                };

            })();


        /*
         * ==========================================
         * SEND TRANSACTION RESULT
         * ==========================================
         */

        if (
            result.type === "ERROR"
        ) {

            return res.status(
                result.status
            ).json(
                result.body
            );

        }


        return res.json(
            result.body
        );


    } catch(error) {

        console.error(
            "❌ CALL NUMBER ERROR:",
            error
        );

        console.error(
            "❌ ERROR MESSAGE:",
            error?.message
        );

        console.error(
            "❌ ERROR STACK:",
            error?.stack
        );

        return res.status(500).json({

            success: false,

            error:
                "Could not call Bingo number",

            debug:
                error?.message ||
                "Unknown error"

        });

    }

});
// ======================================================
// JOIN / START GAME
// ======================================================

app.post("/api/game/start", auth, async (req, res) => {
  try {
    const stake = num(req.body.stake);
const cards = Number(req.body.cards);

const cardNumbers = Array.isArray(req.body.cardNumbers)
    ? req.body.cardNumbers.map(Number)
    : [];
    if (cardNumbers.length !== cards) {
    return res.status(400).json({
        success: false,
        error: "Card numbers do not match card count"
    });
}

if (cardNumbers.some(card => !Number.isInteger(card) || card < 1 || card > 200)) {
    return res.status(400).json({
        success: false,
        error: "Invalid card number"
    });
}


    if (!validStake(stake)) {  
      return res.status(400).json({  
        success: false,  
        error: "Invalid stake"  
      });  
    }  

   if (
    !Number.isInteger(cards) ||
    cards < 0 ||
    cards > MAX_CARDS
) {
    return res.status(400).json({
        success: false,
        error: "Invalid number of cards"
    });
}

    const userId = req.user.id;  

    // -----------------------------  
    // FIND OR CREATE WAITING MATCH  
    // -----------------------------  
    let match = findActiveMatch(stake);  

    if (!match) {  
      const result = db.prepare(`  
        INSERT INTO matches (  
          stake, status, prize_pool, winner_count, paid, countdown_seconds, called_balls, current_ball  
        ) VALUES (?, 'WAITING', 0, 0, 0, ?, '[]', '')  
      `).run(stake, COUNTDOWN_SECONDS);  

      const matchId = Number(result.lastInsertRowid);  
      match = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(matchId);  
    }  

    const matchId = Number(match.id);  

    // -----------------------------  
    // CHECK MATCH STATUS  
    // -----------------------------  
    if (match.status === "FINISHED") {  
      return res.status(400).json({  
        success: false,  
        error: "This game has already finished"  
      });  
    }  


    // ==================================================
// LATE PLAYER JOINING A PLAYING MATCH
// ==================================================

if (match.status === "PLAYING") {

    // ----------------------------------------------
    // Check whether this player already has a record
    // ----------------------------------------------

    const existingLateGame = db.prepare(`
        SELECT *
        FROM games
        WHERE match_id = ?
          AND user_id = ?
        LIMIT 1
    `).get(matchId, userId);

    if (existingLateGame) {

        return res.json({

            success: true,

            gameId: matchId,
            sharedGameId: matchId,
            matchId: matchId,

            playerGameId:
                existingLateGame.id,

            stake: stake,

            cards:
                existingLateGame.cards || 0,

            status: "PLAYING",

            playerStatus:
                existingLateGame.status,

            lateJoin: true,

            started: true,

            message:
                "Game already playing. Waiting for next round."

        });

    }

    // ----------------------------------------------
    // DO NOT charge this player
    // DO NOT select cards
    // DO NOT start a new match
    // ----------------------------------------------

    const lateGame = db.prepare(`
        INSERT INTO games (
            match_id,
            user_id,
            stake,
            cards,
            result,
            prize,
            status,
            play_spent,
            main_spent
        )
        VALUES (
            ?,
            ?,
            ?,
            0,
            'WAITING_NEXT_ROUND',
            0,
            'WAITING_NEXT_ROUND',
            0,
            0
        )
    `).run(
        matchId,
        userId,
        stake
    );

    return res.json({

        success: true,

        gameId: matchId,
        sharedGameId: matchId,
        matchId: matchId,

        playerGameId:
            Number(
                lateGame.lastInsertRowid
            ),

        stake: stake,

        cards: 0,

        status: "PLAYING",

        playerStatus:
            "WAITING_NEXT_ROUND",

        lateJoin: true,

        started: true,

        message:
            "Game is already playing. " +
            "Wait for the next card selection."

    });
}
    // -----------------------------  
    // CHECK IF PLAYER ALREADY JOINED  
    // -----------------------------  
    const existingGame = db.prepare(`  
      SELECT * FROM games WHERE match_id = ? AND user_id = ? LIMIT 1  
    `).get(matchId, userId);  

    if (existingGame) {  
       const players= db.prepare(`  
        SELECT COUNT(*) AS count FROM games WHERE match_id = ?  
      `).get(matchId);  

      return res.json({  
        success: true,  
        gameId: matchId,  
        sharedGameId: matchId,  
        matchId,  
        playerGameId: existingGame.id,  
        stake: existingGame.stake,  
        cards: existingGame.cards,  
        playerCount: players.count,  
        minPlayers: MIN_PLAYERS,  
        countdown: getMatchCountdown(match),  
        status: match.status,  
        alreadyJoined: true  
      });  
    }  

    const cost = num(stake * cards);  
    const user = db.prepare(`  
      SELECT id, balance, play_balance FROM users WHERE id = ?  
    `).get(userId);  

    if (!user) {  
      return res.status(404).json({  
        success: false,  
        error: "User not found"  
      });  
    }  

    const totalBalance = num(Number(user.balance) + Number(user.play_balance));  
    if (totalBalance < cost) {  
      return res.status(400).json({  
        success: false,  
        error: "Insufficient balance",  
        required: cost,  
        balance: totalBalance  
      });  
    }  

    const playSpent = Math.min(Number(user.play_balance), cost);  
    const mainSpent = num(cost - playSpent);  

    // -----------------------------  
    // TRANSACTION  
    // -----------------------------  
    const transaction = db.transaction(() => {  
      const updateBalance = db.prepare(`  
        UPDATE users  
        SET balance = balance - ?, play_balance = play_balance - ?  
        WHERE id = ? AND balance >= ? AND play_balance >= ?  
      `).run(mainSpent, playSpent, userId, mainSpent, playSpent);  

      if (updateBalance.changes !== 1) {  
        throw new Error("Balance changed. Please try again.");  
      }  

     const gameResult = db.prepare(`
  INSERT INTO games (
    match_id,
    user_id,
    stake,
    cards,
    card_numbers,
    result,
    prize,
    status,
    play_spent,
    main_spent
  )
  VALUES (?, ?, ?, ?, ?, 'STARTED', 0, 'STARTED', ?, ?)
`).run(
    matchId,
    userId,
    stake,
    cards,
    JSON.stringify(cardNumbers),
    playSpent,
    mainSpent
);
      if (!match.countdown_started_at) {  
        db.prepare(`  
          UPDATE matches  
          SET countdown_started_at = CURRENT_TIMESTAMP, countdown_seconds = ?, prize_pool = ?  
          WHERE id = ? AND status = 'WAITING'  
        `).run(COUNTDOWN_SECONDS, 0, matchId);  
      } else {  
        const totalCost = db.prepare(`  
          SELECT COALESCE(SUM(stake * cards), 0) AS total FROM games WHERE match_id = ?  
        `).get(matchId).total;  

        db.prepare(`  
          UPDATE matches SET prize_pool = ? WHERE id = ?  
        `).run(num(totalCost * WIN_RATE), matchId);  
      }  

      return Number(gameResult.lastInsertRowid);  
    });  

    // Execute transaction  
   const playerGameId = transaction();

// -----------------------------
// RESPONSE
// -----------------------------

const updatedMatch = db.prepare(`
    SELECT *
    FROM matches
    WHERE id = ?
`).get(matchId);

const playerCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM games
    WHERE match_id = ?
`).get(matchId).count;

const newBalance = db.prepare(`
    SELECT
        balance,
        play_balance
    FROM users
    WHERE id = ?
`).get(userId);

return res.json({

    success: true,

    // SHARED GAME ID
    gameId: matchId,
    sharedGameId: matchId,
    matchId: matchId,

    // THIS PLAYER'S OWN GAME RECORD
    playerGameId: playerGameId,

    stake: stake,
    cards: cards,

    // SHARED MATCH INFORMATION
    playerCount: playerCount,
    minPlayers: MIN_PLAYERS,

    countdown:
        getMatchCountdown(updatedMatch),

    status:
        updatedMatch.status,

    ready:
        playerCount >= MIN_PLAYERS,

    started:
        updatedMatch.status === "PLAYING",

    balance:
        num(newBalance.balance),

    playBalance:
        num(newBalance.play_balance),

    totalBalance:
        num(
            Number(newBalance.balance) +
            Number(newBalance.play_balance)
        )
});

} catch (err) {

    console.error(
        "GAME START ERROR:",
        err
    );

    return res.status(500).json({
        success: false,
        error:
            err.message ||
            "Failed to start/join game"
    });
}

});
// ============================================================
// FINALIZE SHARED MATCH PAYOUT
// ============================================================
function finalizeMatchPayout(matchId) {

    console.log(
        "💰 FINALIZING MATCH PAYOUT:",
        matchId
    );

    const transaction =
        db.transaction(() => {

            // ==================================================
            // GET MATCH
            // ==================================================

            const match =
                db.prepare(`
                    SELECT *
                    FROM matches
                    WHERE id = ?
                `).get(matchId);

            if (!match) {

                throw new Error(
                    "Match not found: " + matchId
                );

            }


            // ==================================================
            // PREVENT DOUBLE PAYOUT
            // ==================================================

            if (Number(match.paid) === 1) {

                console.log(
                    "⚠️ MATCH ALREADY PAID:",
                    matchId
                );

                return {
                    complete: true,
                    alreadyPaid: true,
                    totalCost: 0,
                    totalPrize: 0,
                    winnerCount: 0,
                    winnerPrize: 0
                };

            }


            // ==================================================
            // GET ALL WINNERS
            // ==================================================

            const winners =
                db.prepare(`
                    SELECT *
                    FROM games
                    WHERE match_id = ?
                      AND status = 'WIN'
                      AND result = 'WIN'
                `).all(matchId);


            console.log(
                "🏆 VERIFIED WINNERS:",
                winners.map(w => ({
                    gameId: w.id,
                    userId: w.user_id,
                    cardNumbers: w.card_numbers,
                    winnerCardNumber:
                        w.winner_card_number,
                    playSpent:
                        Number(w.play_spent || 0),
                    mainSpent:
                        Number(w.main_spent || 0)
                }))
            );


            // ==================================================
            // NO WINNERS
            // ==================================================

            if (winners.length === 0) {

                console.log(
                    "⚠️ NO WINNERS FOUND:",
                    matchId
                );

                return {
                    complete: false,
                    alreadyPaid: false,
                    totalCost: 0,
                    totalPrize: 0,
                    winnerCount: 0,
                    winnerPrize: 0
                };

            }


            // ==================================================
            // GET ALL MATCH GAMES
            // ==================================================

            const matchGames =
                db.prepare(`
                    SELECT
                        id,
                        user_id,
                        play_spent,
                        main_spent,
                        card_numbers,
                        status,
                        result
                    FROM games
                    WHERE match_id = ?
                `).all(matchId);


            // ==================================================
            // TOTAL MONEY USED
            // ==================================================

            const totalCost =
                matchGames.reduce(
                    (total, game) => {

                        return total
                            + Number(
                                game.play_spent || 0
                            )
                            + Number(
                                game.main_spent || 0
                            );

                    },
                    0
                );


            console.log(
                "💵 TOTAL MATCH COST:",
                totalCost
            );


            // ==================================================
            // 85% PRIZE POOL
            // ==================================================

            const totalPrize =
                Math.floor(
                    totalCost * 0.85
                );


            // ==================================================
            // NUMBER OF WINNERS
            // ==================================================

            const winnerCount =
                winners.length;


            // ==================================================
            // WHOLE ETB WINNER SHARE
            // ==================================================

            const winnerPrize =
                Math.floor(
                    totalPrize /
                    winnerCount
                );


            console.log(
                "💰 PAYOUT CALCULATION:",
                {
                    matchId,
                    totalCost,
                    totalPrize,
                    winnerCount,
                    winnerPrize
                }
            );


            // ==================================================
            // PAY ALL WINNERS
            // ==================================================

            for (
                const winner of winners
            ) {

                const userId =
                    Number(
                        winner.user_id
                    );


                // ------------------------------------------------
                // CREDIT MAIN BALANCE
                // ------------------------------------------------

                if (winnerPrize > 0) {

                    const payment =
                        db.prepare(`
                            UPDATE users
                            SET balance =
                                COALESCE(
                                    balance,
                                    0
                                ) + ?
                            WHERE id = ?
                        `).run(
                            winnerPrize,
                            userId
                        );


                    if (
                        payment.changes !== 1
                    ) {

                        throw new Error(
                            `Could not credit winner user ${userId}`
                        );

                    }


                    console.log(
                        "✅ MAIN BALANCE CREDITED:",
                        {
                            userId,
                            amount:
                                winnerPrize
                        }
                    );

                }


                // ------------------------------------------------
                // SAVE WINNER PRIZE
                // ------------------------------------------------

                const paidGame =
    db.prepare(`
        UPDATE games
        SET
            prize = ?,
            status = 'PAID'
        WHERE id = ?
          AND status = 'WIN'
    `).run(
        winnerPrize,
        winner.id
    );


if(
    paidGame.changes !== 1
){

    throw new Error(
        `Could not mark winner game ${winner.id} as PAID`
    );

}

                console.log(
                    "🏆 WINNER PAID:",
                    {
                        gameId:
                            winner.id,
                        userId,
                        prize:
                            winnerPrize
                    }
                );

            }


            // ==================================================
            // FINISH NON-WINNING GAMES
            // ==================================================

            db.prepare(`
                UPDATE games
                SET
                    status = 'FINISHED'
                WHERE match_id = ?
                  AND status NOT IN ('PAID')
            `).run(matchId);


            // ==================================================
            // FINISH MATCH
            // ==================================================

            db.prepare(`
                UPDATE matches
                SET
                    status = 'FINISHED',
                    paid = 1,
                    winner_count = ?
                WHERE id = ?
            `).run(
                winnerCount,
                matchId
            );


            console.log(
                "✅ MATCH FINISHED:",
                {
                    matchId,
                    totalCost,
                    totalPrize,
                    winnerCount,
                    winnerPrize
                }
            );


            return {

                complete: true,

                alreadyPaid: false,

                totalCost:
                    Number(totalCost),

                totalPrize:
                    Number(totalPrize),

                winnerCount:
                    Number(winnerCount),

                winnerPrize:
                    Number(winnerPrize)

            };

        });


    return transaction;
}
// ======================================================
/* ==================================================
   SERVER BINGO CARD GENERATOR
   Must match frontend generateBingoNumbers()
   ================================================== */
function generateServerBingoNumbers(cardNumber){

    const ranges = [
        [1, 15],    // B
        [16, 30],   // I
        [31, 45],   // N
        [46, 60],   // G
        [61, 75]    // O
    ];

    const columns = [];

    for(let column = 0; column < 5; column++){

        const min = ranges[column][0];
        const max = ranges[column][1];

        const numbers = [];

        // Create only numbers for this column
        for(let n = min; n <= max; n++){
            numbers.push(n);
        }

        // Deterministic shuffle
        let seed =
            Number(cardNumber) * 1000 +
            column * 100;

        for(let i = numbers.length - 1; i > 0; i--){

            seed =
                Math.sin(seed) * 100000;

            const random =
                seed - Math.floor(seed);

            const j =
                Math.floor(
                    random * (i + 1)
                );

            const temp = numbers[i];

            numbers[i] = numbers[j];
            numbers[j] = temp;
        }

        // Five unique numbers
        columns.push(
            numbers.slice(0, 5)
        );
    }

    const grid = [];

    for(let row = 0; row < 5; row++){

        for(let column = 0; column < 5; column++){

            if(row === 2 && column === 2){

                grid.push("FREE");

            }else{

                grid.push(
                    columns[column][row]
                );

            }
        }
    }

    return grid;
}
const testServerCard =
    generateServerBingoNumbers(48);

console.log(
    "🧪 SERVER CARD 48:",
    testServerCard
);

console.log(
    "🧪 CARD LENGTH:",
    testServerCard.length
);

console.log(
    "🧪 FREE CELL:",
    testServerCard[12]
);
/* ==================================================
   SERVER MARK CHECK
   Must match frontend isMarked()
   ================================================== */

function isServerMarked(
    value,
    calledBalls
){

    return (
        value === "FREE" ||
        calledBalls.includes(
            Number(value)
        )
    );
}
function generateServerCards(
    cardNumbers
) {

    const result = {};

    if (
        !Array.isArray(cardNumbers)
    ) {

        return result;

    }


    for (
        const cardNumber of cardNumbers
    ) {

        const number =
            Number(cardNumber);


        if (
            !Number.isInteger(number) ||
            number < 1 ||
            number > 200
        ) {

            continue;

        }


        result[number] =
            generateServerBingoNumbers(
                number
            );

    }


    return result;

}
/* ==================================================
   SERVER WIN CHECK
   Must match frontend isWinningCard()
   ================================================== */

function isServerWinningCard(
    card,
    calledBalls
){

    if(
        !Array.isArray(card) ||
        card.length !== 25
    ){

        return false;
    }

    function marked(value){

        return isServerMarked(
            value,
            calledBalls
        );

    }


    // ----------------------------------------------
    // ROWS
    // ----------------------------------------------

    for(
        let row = 0;
        row < 5;
        row++
    ){

        let complete = true;

        for(
            let column = 0;
            column < 5;
            column++
        ){

            if(
                !marked(
                    card[
                        row * 5 +
                        column
                    ]
                )
            ){

                complete = false;
                break;

            }

        }

        if(complete){

            return true;

        }

    }


    // ----------------------------------------------
    // COLUMNS
    // ----------------------------------------------

    for(
        
        column = 0;
        column < 5;
        column++
    ){

        let complete = true;

        for(
            let row = 0;
            row < 5;
            row++
        ){

            if(
                !marked(
                    card[
                        row * 5 +
                        column
                    ]
                )
            ){

                complete = false;
                break;

            }

        }

        if(complete){

            return true;

        }

    }


    // ----------------------------------------------
    // DIAGONAL 1
    // ----------------------------------------------

    if(
        [0,1,2,3,4].every(
            index =>
                marked(
                    card[
                        index * 5 +
                        index
                    ]
                )
        )
    ){

        return true;

    }


    // ----------------------------------------------
    // DIAGONAL 2
    // ----------------------------------------------

    if(
        [0,1,2,3,4].every(
            index =>
                marked(
                    card[
                        index * 5 +
                        (4 - index)
                    ]
                )
        )
    ){

        return true;

    }


    // ----------------------------------------------
    // FOUR CORNERS
    // ----------------------------------------------

    return (
        marked(card[0]) &&
        marked(card[4]) &&
        marked(card[20]) &&
        marked(card[24])
    );
}

app.post("/api/game/finish", auth, (req, res) => {

    try {

        const matchId =
            integer(
                req.body.matchId ||
                req.body.gameId
            );

        let result =
            String(
                req.body.result ||
                "LOSE"
            ).toUpperCase();

        const cardNumber =
            integer(
                req.body.cardNumber
            );


        // ========================================================
        // BASIC VALIDATION
        // ========================================================

        if (!matchId) {

            return res.status(400).json({

                success: false,

                error:
                    "matchId is required"

            });

        }


        if (
            result !== "WIN" &&
            result !== "LOSE"
        ) {

            result = "LOSE";

        }


        // ========================================================
        // GET PLAYER GAME
        // ========================================================

        const game =
            db.prepare(`
                SELECT *
                FROM games
                WHERE match_id = ?
                  AND user_id = ?
                ORDER BY id DESC
                LIMIT 1
            `).get(
                matchId,
                req.user.id
            );


        console.log(
            "🎫 FINISH GAME DEBUG:",
            {
                matchId,
                userId: req.user.id,
                gameId: game?.id,
                gameStatus: game?.status,
                gameCards: game?.cards,
                gameCardNumbers: game?.card_numbers
            }
        );


        // ========================================================
        // PLAYER GAME MUST EXIST
        // ========================================================

        if (!game) {

            return res.status(404).json({

                success: false,

                error:
                    "Player game not found"

            });

        }


        // ========================================================
        // GET MATCH
        // ========================================================

        const match =
            db.prepare(`
                SELECT *
                FROM matches
                WHERE id = ?
            `).get(
                matchId
            );


        if (!match) {

            return res.status(404).json({

                success: false,

                error:
                    "Match not found"

            });

        }


        // ========================================================
        // ALREADY FINISHED / PAID
        // ========================================================

        if (
            match.status === "FINISHED" ||
            Number(match.paid) === 1
        ) {

            const user =
                db.prepare(`
                    SELECT
                        balance,
                        play_balance
                    FROM users
                    WHERE id = ?
                `).get(
                    req.user.id
                );


            return res.json({

                success: true,

                alreadyFinished: true,

                gameId:
                    matchId,

                matchId,

                sharedGameId:
                    matchId,

                result:
                    game.result,

                prize:
                    num(game.prize),

                mainBalance:
                    num(
                        user.balance
                    ),

                playBalance:
                    num(
                        user.play_balance
                    ),

                matchStatus:
                    match.status,

                payoutComplete:
                    Boolean(
                        match.paid
                    )

            });

        }


        // ========================================================
        // WINNER VALIDATION
        // ========================================================

        if (result === "WIN") {


            // ----------------------------------------------------
            // 1. VALID CARD NUMBER
            // ----------------------------------------------------

            if (
                !Number.isInteger(cardNumber) ||
                cardNumber < 1 ||
                cardNumber > 200
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid winner card number"

                });

            }


            // ----------------------------------------------------
            // 2. GET PLAYER CARD NUMBERS
            // ----------------------------------------------------

            let playerCards = [];

            try {

                playerCards =
                    game.card_numbers
                        ? JSON.parse(
                            game.card_numbers
                        )
                        : [];

            } catch (error) {

                console.error(
                    "❌ PLAYER CARD PARSE ERROR:",
                    error
                );

                playerCards = [];

            }


            if (!Array.isArray(playerCards)) {

                playerCards = [];

            }


            playerCards =
                playerCards.map(
                    Number
                );


            // ----------------------------------------------------
            // 3. CARD MUST BELONG TO PLAYER
            // ----------------------------------------------------

            if (
                !playerCards.includes(
                    Number(cardNumber)
                )
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Winner card does not belong to this player"

                });

            }


            // ----------------------------------------------------
            // 4. SERVER CALLED BALLS
            // ----------------------------------------------------

            let calledBalls = [];

            try {

                calledBalls =
                    match.called_balls
                        ? JSON.parse(
                            match.called_balls
                        )
                        : [];

            } catch (error) {

                console.error(
                    "❌ CALLED BALLS PARSE ERROR:",
                    error
                );

                calledBalls = [];

            }


            if (!Array.isArray(calledBalls)) {

                calledBalls = [];

            }


            calledBalls =
                calledBalls
                    .map(Number)
                    .filter(
                        number =>
                            Number.isInteger(number) &&
                            number >= 1 &&
                            number <= 75
                    );


            // ----------------------------------------------------
            // 5. GENERATE SERVER CARD
            // ----------------------------------------------------

            const winningCard =
                generateServerBingoNumbers(
                    Number(cardNumber)
                );


            // ----------------------------------------------------
            // 6. SERVER BINGO CHECK
            // ----------------------------------------------------

            const actuallyWon =
                isServerWinningCard(
                    winningCard,
                    calledBalls
                );


            console.log(
                "🔎 SERVER WIN CHECK:",
                {
                    matchId,
                    userId: req.user.id,
                    cardNumber,
                    winningCard,
                    calledBalls,
                    calledCount:
                        calledBalls.length,
                    matchStatus:
                        match.status
                }
            );


            // ----------------------------------------------------
            // 7. REJECT INVALID CLAIM
            // ----------------------------------------------------

            if (!actuallyWon) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid Bingo claim"

                });

            }

        }


        // ========================================================
        // PREVENT SAME PLAYER CLAIMING AGAIN
        // ========================================================

        if (
            result === "WIN" &&
            game.status === "WIN"
        ) {

            return res.json({

                success: true,

                alreadyClaimed: true,

                gameId:
                    matchId,

                matchId,

                sharedGameId:
                    matchId,

                result: "WIN",

                prize:
                    num(game.prize),

                matchStatus:
                    match.status,

                payoutComplete:
                    Boolean(
                        match.paid
                    )

            });

        }


        // ========================================================
        // SAVE RESULT
        // ========================================================

        if (result === "WIN") {


            // ----------------------------------------------------
            // IMPORTANT:
            //
            // DO NOT SET FINISHED HERE.
            //
            // Keep status = WIN until payout.
            // This allows finalizeMatchPayout() to find
            // ALL winners.
            // ----------------------------------------------------

            db.prepare(`
                UPDATE games
                SET
                    result = 'WIN',
                    winner_card_number = ?,
                    status = 'WIN',
                    finished_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND user_id = ?
            `).run(
                Number(cardNumber),
                game.id,
                req.user.id
            );


            console.log(
                "🏆 WINNER CLAIM SAVED:",
                {
                    matchId,
                    userId: req.user.id,
                    cardNumber:
                        Number(cardNumber),
                    gameId:
                        game.id
                }
            );


            // ====================================================
            // CHECK WHETHER THIS IS FIRST WINNER
            // ====================================================

            const claimWindow =
                db.prepare(`
                    UPDATE matches

                    SET status = 'CLAIM_WINDOW'

                    WHERE id = ?

                      AND status = 'PLAYING'

                      AND paid = 0
                `).run(
                    matchId
                );


            const firstWinner =
                claimWindow.changes > 0;


            console.log(
                "🏆 WINNER CLAIM STATUS:",
                {
                    matchId,
                    userId: req.user.id,
                    firstWinner,
                    matchStatus:
                        firstWinner
                            ? "CLAIM_WINDOW"
                            : "CLAIM_WINDOW_ALREADY_ACTIVE"
                }
            );


            // ====================================================
            // FIRST WINNER STARTS 3 SECOND TIMER
            // ====================================================

            if (
                firstWinner &&
                !winnerClaimTimers.has(
                    matchId
                )
            ) {


                console.log(
                    "⏳ STARTING 3 SECOND WINNER WINDOW:",
                    matchId
                );


                const timer =
                    setTimeout(
                        () => {

                            try {

                                console.log(
                                    "⏰ 3 SECOND CLAIM WINDOW FINISHED:",
                                    matchId
                                );


                                winnerClaimTimers.delete(
                                    matchId
                                );


                                // --------------------------------
                                // FINALIZE ALL WINNERS
                                // --------------------------------
// --------------------------------
// FINALIZE ALL WINNERS
// --------------------------------

console.log(
    "🔎 BEFORE FINALIZE — CHECKING MATCH GAMES:",
    matchId
);

const gamesBeforePayout =
    db.prepare(`
        SELECT
            id,
            user_id,
            match_id,
            status,
            result,
            play_spent,
            main_spent,
            prize,
            winner_card_number,
            card_numbers
        FROM games
        WHERE match_id = ?
    `).all(matchId);

console.log(
    "🎮 GAMES BEFORE PAYOUT:",
    gamesBeforePayout.map(game => ({
        id: game.id,
        userId: game.user_id,
        matchId: game.match_id,
        status: game.status,
        result: game.result,
        playSpent:
            Number(game.play_spent || 0),
        mainSpent:
            Number(game.main_spent || 0),
        prize:
            Number(game.prize || 0),
        winnerCardNumber:
            game.winner_card_number,
        cardNumbers:
            game.card_numbers
    }))
);

const payout =
    finalizeMatchPayout(
        matchId
    );

                                console.log(
                                    "💰 FINAL PAYOUT COMPLETE:",
                                    {
                                        matchId,
                                        payout
                                    }
                                );


                            } catch (error) {

                                console.error(
                                    "❌ DELAYED PAYOUT ERROR:",
                                    error
                                );

                            }

                        },
                        WINNER_CLAIM_WINDOW_MS
                    );


                winnerClaimTimers.set(
                    matchId,
                    timer
                );

            }

        }


        // ========================================================
        // LOSE
        // ========================================================

        else {

            db.prepare(`
                UPDATE games
                SET
                    result = 'LOSE',
                    status = 'FINISHED',
                    finished_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND user_id = ?
                  AND status NOT IN ('WIN', 'PAID')
            `).run(
                game.id,
                req.user.id
            );

        }


        // ========================================================
        // GET UPDATED GAME
        // ========================================================

        const updatedGame =
            db.prepare(`
                SELECT *
                FROM games
                WHERE id = ?
            `).get(
                game.id
            );


        // ========================================================
        // GET UPDATED MATCH
        // ========================================================

        const updatedMatch =
            db.prepare(`
                SELECT *
                FROM matches
                WHERE id = ?
            `).get(
                matchId
            );


        // ========================================================
        // GET USER BALANCE
        // ========================================================

        const user =
            db.prepare(`
                SELECT
                    balance,
                    play_balance
                FROM users
                WHERE id = ?
            `).get(
                req.user.id
            );


        // ========================================================
        // TOTAL GAME COST
        // ========================================================

        const totalCost =
            updatedMatch.prize_pool
                ? num(
                    Number(
                        updatedMatch.prize_pool
                    ) / WIN_RATE
                )
                : 0;


        // ========================================================
        // RESPONSE
        // ========================================================

        return res.json({

            success: true,

            gameId:
                matchId,

            matchId,

            sharedGameId:
                matchId,

            result:
                updatedGame.result,

            prize:
                num(
                    updatedGame.prize
                ),

            totalPlayerCost:
                totalCost,

            totalPrize:
                num(
                    updatedMatch.prize_pool
                ),

            winnerCount:
                Number(
                    updatedMatch.winner_count || 0
                ),

            playerCount:
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM games
                    WHERE match_id = ?
                `).get(
                    matchId
                ).count,

            matchStatus:
                updatedMatch.status,

            payoutComplete:
                Boolean(
                    updatedMatch.paid
                ),

            mainBalance:
                num(
                    user.balance
                ),

            playBalance:
                num(
                    user.play_balance
                )

        });


    } catch (error) {

        console.error(
            "GAME FINISH ERROR:",
            error
        );


        return res.status(500).json({

            success: false,

            error:
                error.message ||
                "Could not finish game"

        });

    }

});
// ======================================================
// CREATE DEPOSIT
// ======================================================
//
// Deposit starts as PENDING.
// It does NOT increase Play Wallet
// until admin approves it.
// ======================================================

app.post(
"/api/deposit",
auth,
(req, res) => {

try {  

        const amount =  
            num(  
                req.body.amount  
            );  

        const reference =  
            String(  
                req.body.reference ||  
                ""  
            ).trim();  

        if (  
            amount <  
            MIN_DEPOSIT  
        ) {  

            return res.status(400).json({  

                success: false,  

                error:  
                    `Minimum deposit is ${MIN_DEPOSIT} ETB`  

            });  
        }  

        if (!reference) {  

            return res.status(400).json({  

                success: false,  

                error:  
                    "Payment reference is required"  

            });  
        }  

        const result =  
            db.prepare(`  
                INSERT INTO deposits (  
                    user_id,  
                    amount,  
                    reference,  
                    status  
                )  
                VALUES (  
                    ?,  
                    ?,  
                    ?,  
                    'pending'  
                )  
            `).run(  
                req.user.id,  
                amount,  
                reference  
            );  

        const depositId =  
            Number(  
                result.lastInsertRowid  
            );  

        res.json({  

            success: true,  

            depositId,  

            amount,  

            reference,  

            status:  
                "PENDING",  

            message:  
                "Deposit submitted. Waiting for admin approval."  

        });  

    } catch (error) {  

        console.error(  
            "DEPOSIT ERROR:",  
            error  
        );  

        res.status(500).json({  

            success: false,  

            error:  
                "Could not submit deposit"  

        });  
    }  
}

);

// ======================================================
// DEPOSIT HISTORY
// ======================================================

app.get(
"/api/deposits",
auth,
(req, res) => {

const deposits =  
        db.prepare(`  
            SELECT  
                id,  
                amount,  
                reference,  
                status,  
                created_at,  
                approved_at  
            FROM deposits  
            WHERE user_id = ?  
            ORDER BY id DESC  
            LIMIT 100  
        `).all(  
            req.user.id  
        );  

    res.json({  

        success: true,  

        deposits  

    });  

}

);

// ======================================================
// ADMIN CHECK
// ======================================================

function isAdmin(chatId) {

return (  
    ADMIN_CHAT_ID &&  
    String(chatId) ===  
    String(ADMIN_CHAT_ID)  
);

}

// ======================================================
// ADMIN APPROVE DEPOSIT
// ======================================================
//
// approve_deposit:ID
//
// Adds money to PLAY WALLET.
// ======================================================

function approveDeposit(depositId) {

    const transaction = db.transaction(() => {

        const deposit = db.prepare(`
            SELECT *
            FROM deposits
            WHERE id = ?
        `).get(depositId);

        if (!deposit) {
            throw new Error("Deposit not found");
        }

        if (deposit.status !== "pending") {
            throw new Error(
                `Deposit is already ${deposit.status}`
            );
        }

        const amount = Number(deposit.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error(
                `Invalid deposit amount: ${deposit.amount}`
            );
        }

        // Approve deposit
        db.prepare(`
            UPDATE deposits
            SET
                status = 'approved',
                approved_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(depositId);

        // Add money to Play Wallet
        const result = db.prepare(`
            UPDATE users
            SET
                play_balance =
                    COALESCE(play_balance, 0) + ?
            WHERE id = ?
        `).run(
            amount,
            deposit.user_id
        );

        if (result.changes !== 1) {
            throw new Error(
                "User wallet was not updated"
            );
        }

        return deposit;
    });

    return transaction();
}

// ======================================================
// ADMIN REJECT DEPOSIT
// ======================================================
//
// reject_deposit:ID
//
// IMPORTANT:
// Money is NOT added to Play Wallet.
// ======================================================

function rejectDeposit(
depositId
) {

const deposit =  
    db.prepare(`  
        SELECT *  
        FROM deposits  
        WHERE id = ?  
    `).get(  
        depositId  
    );  

if (!deposit) {  

    throw new Error(  
        "Deposit not found"  
    );  

}  

if (  
    deposit.status !==  
    "pending"  
) {  

    throw new Error(  
        `Deposit is already ${deposit.status}`  
    );  

}  

db.prepare(`  
    UPDATE deposits  

    SET  
        status = 'rejected'  

    WHERE id = ?  
`).run(  
    depositId  
);  

return deposit;

}

// ======================================================
// CREATE WITHDRAWAL
// ======================================================
//
// Withdrawal uses MAIN WALLET only.
//
// When submitted:
//     Main Wallet -> reserved/deducted
//
// Admin APPROVE:
//     money remains deducted
//
// Admin REJECT:
//     money is returned to Main Wallet
// ======================================================

app.post(
"/api/withdraw",
auth,
(req, res) => {

try {  

        const amount =  
            num(  
                req.body.amount  
            );  

        const accountDetails =  
            String(  
                req.body.accountDetails ||  
                req.body.account_details ||  
                ""  
            ).trim();  

        if (  
            amount <  
            MIN_WITHDRAW  
        ) {  

            return res.status(400).json({  

                success: false,  

                error:  
                    `Minimum withdrawal is ${MIN_WITHDRAW} ETB`  

            });  
        }  

        if (!accountDetails) {  

            return res.status(400).json({  

                success: false,  

                error:  
                    "Account details are required"  

            });  
        }  

        // ------------------------------------------------  
        // TRANSACTION  
        // ------------------------------------------------  

        const transaction =  
            db.transaction(() => {  

                const user =  
                    db.prepare(`  
                        SELECT  
                            balance  
                        FROM users  
                        WHERE id = ?  
                    `).get(  
                        req.user.id  
                    );  

                if (!user) {  

                    throw new Error(  
                        "User not found"  
                    );  

                }  

                const balance =  
                    num(  
                        user.balance  
                    );  

                if (  
                    balance <  
                    amount  
                ) {  

                    throw new Error(  
                        "Insufficient Main Wallet balance"  
                    );  

                }  

                // ----------------------------------------  
                // RESERVE MONEY  
                // ----------------------------------------  

                db.prepare(`  
                    UPDATE users  

                    SET  
                        balance =  
                            balance - ?  

                    WHERE id = ?  

                    AND balance >= ?  
                `).run(  
                    amount,  
                    req.user.id,  
                    amount  
                );  

                // ----------------------------------------  
                // CREATE WITHDRAWAL  
                // ----------------------------------------  

                const result =  
                    db.prepare(`  
                        INSERT INTO withdrawals (  
                            user_id,  
                            telegram_id,  
                            amount,  
                            account_details,  
                            status  
                        )  
                        VALUES (  
                            ?,  
                            ?,  
                            ?,  
                            ?,  
                            'pending'  
                        )  
                    `).run(  
                        req.user.id,  
                        String(  
                            req.telegramUser.id  
                        ),  
                        amount,  
                        accountDetails  
                    );  

                return Number(  
                    result.lastInsertRowid  
                );  
            });  

        const withdrawalId =  
            transaction();  

        const updatedUser =  
            db.prepare(`  
                SELECT  
                    balance,  
                    play_balance  
                FROM users  
                WHERE id = ?  
            `).get(  
                req.user.id  
            );  

        res.json({  

            success: true,  

            withdrawalId,  

            amount,  

            accountDetails,  

            status:  
                "PENDING",  

            mainBalance:  
                num(  
                    updatedUser.balance  
                ),  

            playBalance:  
                num(  
                    updatedUser.play_balance  
                ),  

            message:  
                "Withdrawal submitted. Waiting for admin approval."  

        });  

    } catch (error) {  

        console.error(  
            "WITHDRAW ERROR:",  
            error  
        );  

        res.status(400).json({  

            success: false,  

            error:  
                error.message ||  
                "Could not submit withdrawal"  

        });  
    }  
}

);

// ======================================================
// WITHDRAWAL HISTORY
// ======================================================

app.get(
"/api/withdrawals",
auth,
(req, res) => {

const withdrawals =  
        db.prepare(`  
            SELECT  
                id,  
                amount,  
                account_details,  
                status,  
                created_at,  
                approved_at  
            FROM withdrawals  

            WHERE user_id = ?  

            ORDER BY id DESC  

            LIMIT 100  
        `).all(  
            req.user.id  
        );  

    res.json({  

        success: true,  

        withdrawals  

    });  

}

);

// ======================================================
// APPROVE WITHDRAWAL
// ======================================================
//
// Money was already reserved when the
// user submitted the withdrawal.
//
// Therefore APPROVAL does NOT subtract
// the money again.
// ======================================================

function approveWithdrawal(
withdrawalId
) {

const transaction =  
    db.transaction(() => {  

        const withdrawal =  
            db.prepare(`  
                SELECT *  
                FROM withdrawals  
                WHERE id = ?  
            `).get(  
                withdrawalId  
            );  

        if (!withdrawal) {  

            throw new Error(  
                "Withdrawal not found"  
            );  

        }  

        if (  
            withdrawal.status !==  
            "pending"  
        ) {  

            throw new Error(  
                `Withdrawal is already ${withdrawal.status}`  
            );  

        }  

        db.prepare(`  
            UPDATE withdrawals  

            SET  
                status = 'approved',  
                approved_at =  
                    CURRENT_TIMESTAMP  

            WHERE id = ?  
        `).run(  
            withdrawalId  
        );  

        return withdrawal;  
    });  

return transaction();

}

// ======================================================
// REJECT WITHDRAWAL
// ======================================================
//
// The amount was reserved from Main Wallet.
//
// When rejected, refund it.
// ======================================================

function rejectWithdrawal(
withdrawalId
) {

const transaction =  
    db.transaction(() => {  

        const withdrawal =  
            db.prepare(`  
                SELECT *  
                FROM withdrawals  
                WHERE id = ?  
            `).get(  
                withdrawalId  
            );  

        if (!withdrawal) {  

            throw new Error(  
                "Withdrawal not found"  
            );  

        }  

        if (  
            withdrawal.status !==  
            "pending"  
        ) {  

            throw new Error(  
                `Withdrawal is already ${withdrawal.status}`  
            );  

        }  

        // ----------------------------------------------  
        // REFUND MAIN WALLET  
        // ----------------------------------------------  

        db.prepare(`  
            UPDATE users  

            SET  
                balance =  
                    balance + ?  

            WHERE id = ?  
        `).run(  
            num(  
                withdrawal.amount  
            ),  
            withdrawal.user_id  
        );  

        // ----------------------------------------------  
        // MARK REJECTED  
        // ----------------------------------------------  

        db.prepare(`  
            UPDATE withdrawals  

            SET  
                status = 'rejected'  

            WHERE id = ?  
        `).run(  
            withdrawalId  
        );  

        return withdrawal;  
    });  

return transaction();

}

// ======================================================
// TELEGRAM BOT
// ======================================================

let bot = null;
const userState = {};
const depositSessions = new Map();
if (BOT_TOKEN) {

bot =  
    new TelegramBot(  
        BOT_TOKEN,  
        {  
            polling: true  
        }  
    );  

console.log(  
    "✅ Telegram bot polling started"  
);

} else {

console.warn(  
    "⚠️ BOT_TOKEN is not configured"  
);

}

// ======================================================
// BOT SEND MESSAGE HELPER
// ======================================================

async function sendBotMessage(
chatId,
text,
options = {}
) {

if (!bot) {  
    return;  
}  

try {  

    await bot.sendMessage(  
        chatId,  
        text,  
        options  
    );  

} catch (error) {  

    console.error(  
        "BOT MESSAGE ERROR:",  
        error.message  
    );  
}

}

// ======================================================
// USER TELEGRAM ID -> DATABASE USER
// ======================================================

function getUserByTelegramId(
telegramId
) {

return db.prepare(`  
    SELECT *  
    FROM users  
    WHERE telegram_id = ?  
`).get(  
    String(telegramId)  
);

}

// ======================================================
// /START
// ======================================================

if (bot) {

bot.onText(  
    /^(\/start|⭐ Start)$/, 
    async msg => {  

        const chatId =  
            msg.chat.id;  

        const telegramUser =  
            msg.from;  

        try {  

            const user =  
                getOrCreateUser(  
                    telegramUser  
                );  

            let keyboard = [];

if (WEB_APP_URL) {

    console.log(
        "WEB_APP_URL USED BY BOT:",
        WEB_APP_URL
    );

    keyboard = [

        [
            {
                text: "⭐ Start",
                callback_data: "start_menu"
            },
            {
                text: "📝 Register",
                callback_data: "register"
            }
        ],

        [
            {
                text: "🎮 Play",
                 web_app: {  
                    url: WEB_APP_URL  
                    }   
            },
            {
                text: "💰 Balance",
                callback_data: "balance"
            }
        ],

        [
            {
                text: "➕ Deposit",
                callback_data: "deposit"
            },
            {
                text: "💸 Withdraw",
                callback_data: "withdraw"
            }
        ],

        [
            {
                text: "📜 Game History",
                callback_data: "history"
            }
        ]

    ];
}

await sendBotMessage(  
                chatId,  

                `🎉 Welcome to Frick Bingo!

Hello ${
telegramUser.first_name ||
"Player"
}!

Your account is ready.

💰 Main Wallet:
${num(user.balance)} ETB

🎮 Play Wallet:
${num(user.play_balance)} ETB

Choose an option below.`,

{  
                    reply_markup: {   
                         inline_keyboard: keyboard

                    }  
                }  
            );  

        } catch (error) {  

            console.error(  
                "/start ERROR:",  
                error  
            );  

            await sendBotMessage(  
                chatId,  
                "❌ Something went wrong."  
            );  
        }  

    }  
);

// ======================================================
// /REGISTER
// ======================================================

bot.onText(  
    /^(\/register|📝 Register)$/,
    async msg => {  

        try {  

            const user =  

                getOrCreateUser(  
                    msg.from  
                );  

            await sendBotMessage(  

                msg.chat.id,  

                `✅ Registration successful!

Player:
${
user.first_name ||
"Player"
}

Telegram ID:
${user.telegram_id}

💰 Main Wallet:
${num(user.balance)} ETB

🎮 Play Wallet:
${num(user.play_balance)} ETB`

);  

        } catch (error) {  

            console.error(  
                "/register ERROR:",  
                error  
            );  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Registration failed."  
            );  
        }  

    }  
);

// ======================================================
// /BALANCE
// ======================================================

bot.onText(  
    /^(\/balance|💰 Balance)$/,  
    async msg => {  

        try {  

            const user =  
                getUserByTelegramId(  
                    msg.from.id  
                );  

            if (!user) {  

                await sendBotMessage(  
                    msg.chat.id,  
                    "❌ Please use /start first."  
                );  

                return;  
            }  

            await sendBotMessage(  

                msg.chat.id,  

                `💰 Your Balance

Main Wallet:
${num(user.balance)} ETB

Play Wallet:
${num(user.play_balance)} ETB

Total:
${num(
user.balance +
user.play_balance
)} ETB`

);  

        } catch (error) {  

            console.error(  
                "/balance ERROR:",  
                error  
            );  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Could not load balance."  
            );  
        }  

    }  
);

// ======================================================
// /PLAY
// ======================================================

bot.onText(  
    /^(\/play|🎮 Play)$/,  
    async msg => {  

        if (!WEB_APP_URL) {  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Game URL is not configured."  
            );  

            return;  
        }  

        await sendBotMessage(  

            msg.chat.id,  

            "🎮 Tap below to open Frick Bingo.",  

            {  
                reply_markup: {  
                    inline_keyboard: [  
                        [  
                            {  
                                text:  
                                    "🎮 PLAY FRICK BINGO",  
                                web_app: {  
                                    url: WEB_APP_URL  
                                }  
                            }  
                        ]  
                    ]  
                }  
            }  

        );  

    }  
);

// ======================================================
// /GAMES
// ======================================================

bot.onText(  
    /^\/games$/,  
    async msg => {  

        try {  

            const user =  
                getUserByTelegramId(  
                    msg.from.id  
                );  

            if (!user) {  

                await sendBotMessage(  
                    msg.chat.id,  
                    "❌ Please use /start first."  
                );  

                return;  
            }  

            const games =  
                db.prepare(`  
                    SELECT  
                        id,  
                        match_id,  
                        stake,  
                        cards,  
                        result,  
                        prize,  
                        status,  
                        created_at  
                    FROM games  

                    WHERE user_id = ?  

                    ORDER BY id DESC  

                    LIMIT 10  
                `).all(  
                    user.id  
                );  

            if (  
                games.length === 0  
            ) {  

                await sendBotMessage(  
                    msg.chat.id,  
                    "📋 You have no games yet."  
                );  

                return;  
            }  

            let text =  
                "🎮 Your Recent Games\n\n";  

            games.forEach(  
                (game, index) => {  

                    text +=  
                        `${index + 1}. ` +  
                        `Game #${game.match_id || game.id}\n`;  

                    text +=  
                        `Stake: ${num(game.stake)} ETB\n`;  

                    text +=  
                        `Cards: ${game.cards}\n`;  

                    text +=  
                        `Result: ${game.result}\n`;  

                    text +=  
                        `Prize: ${num(game.prize)} ETB\n`;  

                    text +=  
                        `Status: ${game.status}\n\n`;  
                }  
            );  

            await sendBotMessage(  
                msg.chat.id,  
                text  
            );  

        } catch (error) {  

            console.error(  
                "/games ERROR:",  
                error  
            );  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Could not load games."  
            );  
        }  

    }  
);

// ======================================================
// /HELP
// ======================================================

bot.onText(  
    /^\/help$/,  
    async msg => {  

        await sendBotMessage(  

            msg.chat.id,

`ℹ️ Frick Bingo Help

/start
Create/open your player account.

/balance
Check Main and Play Wallet.

/play
Open the Frick Bingo game.

/games
View recent games.

/deposit
Get deposit instructions.

/withdraw
Get withdrawal instructions.

🎮 Game Rule

Your game cost is:

Stake × Number of Cards

The total prize is:

85% × TOTAL COST PAID BY ALL PLAYERS IN THE SAME GAME

If several players win at the same time,
the prize is divided equally among them.

💰 Winning money is added to Main Wallet.`

);  

    }  
);

// ======================================================
// DEPOSIT
// ======================================================

bot.onText(
    /^(\/deposit|➕ Deposit)$/,
    async msg => {

        const chatId = msg.chat.id;

        userState[chatId] = {
            step: "deposit_amount"
        };

        await sendBotMessage(
            chatId,
            `1. ከዚህ በታች በተቀመጠው የቴሌ ብር አካውንት ገቢ ያድርጉ።
ከ10 ብር ጀምሮ የሚፈልጉትን መጠን ይላኩ።

ስም = Mulualem
ስልክ = 0940521110

2. 💰 ገቢ የሚያደርጉትን መጠን ያስገቡ።`
        );
    }
);


// ======================================================
// DEPOSIT MESSAGE HANDLER
// ======================================================

bot.on(
    "message",
    async msg => {

        if (!msg.text) return;

        const chatId = msg.chat.id;
        const text = msg.text.trim();

        if (text.startsWith("/")) return;

        const state = userState[chatId];

        if (!state) return;


        // ==================================================
        // STEP 2 — AMOUNT
        // ==================================================

        if (state.step === "deposit_amount") {

            const amount = Number(
                text.replace(/,/g, "")
            );

            if (
                !Number.isFinite(amount) ||
                amount < 10
            ) {

                await sendBotMessage(
                    chatId,
                    "❌ እባክዎ ከ10 ብር ጀምሮ ትክክለኛ የገንዘብ መጠን ያስገቡ።"
                );

                return;
            }

            userState[chatId] = {
                step: "deposit_sms",
                amount: amount
            };

            await sendBotMessage(
                chatId,
                "3. 🧾 በቴሌ ብር የላኩበትን SMS እዚህ ፓስት ያድርጉ።"
            );

            return;
        }


        // ==================================================
        // STEP 3 — TELEBIRR SMS
        // ==================================================

        if (state.step === "deposit_sms") {

            const sms = text;

            if (sms.length < 5) {

                await sendBotMessage(
                    chatId,
                    "❌ እባክዎ ትክክለኛውን የቴሌ ብር SMS ይላኩ።"
                );

                return;
            }

            const user =
                getUserByTelegramId(chatId);

            if (!user) {

                await sendBotMessage(
                    chatId,
                    "❌ ተጠቃሚው አልተመዘገበም።"
                );

                delete userState[chatId];

                return;
            }


            // Save deposit as PENDING
            const result = db.prepare(`
                INSERT INTO deposits (
                    user_id,
                    amount,
                    reference,
                    status
                )
                VALUES (
                    ?,
                    ?,
                    ?,
                    'pending'
                )
            `).run(
                user.id,
                state.amount,
                sms
            );


            const depositId =
                Number(result.lastInsertRowid);


            // Clear user's deposit state
            delete userState[chatId];


            // Tell user
            await sendBotMessage(
                chatId,
                `✅ የገቢ ጥያቄዎ ተቀብሏል።

💰 መጠን: ${state.amount} ETB
📌 Status: PENDING

⏳ አስተዳዳሪው ካጸደቀው በኋላ ገንዘቡ ወደ Play Wallet ይጨመራል።`
            );


            // Send deposit to admin
            await sendBotMessage(
                ADMIN_CHAT_ID,
                `💰 NEW DEPOSIT

👤 User: ${user.first_name || ""}
🆔 Telegram ID: ${user.telegram_id}

💵 Amount: ${state.amount} ETB

🧾 Telebirr SMS:
${sms}

📌 Status: PENDING`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: "✅ Approve",
                                    callback_data:
                                        `approve_deposit:${depositId}`
                                },
                                {
                                    text: "❌ Reject",
                                    callback_data:
                                        `reject_deposit:${depositId}`
                                }
                            ]
                        ]
                    }
                }
            );

            return;
        }

    }
);

// ======================================================
// /WITHDRAW
// ======================================================

bot.onText(  
    /^(\/withdraw|💸 Withdraw)$/,
    async msg => {  

        await sendBotMessage(  

            msg.chat.id,
            

`💸 Withdrawal

Minimum withdrawal:
${MIN_WITHDRAW} ETB

Withdrawal is taken from your Main Wallet only.

When you submit a withdrawal:

⏳ The amount is reserved.

Admin APPROVE:
The withdrawal remains deducted.

Admin REJECT:
The amount is returned to your Main Wallet.

Please submit your withdrawal account/payment details through the game.`

);  

    }  
);

// ======================================================
// ADMIN APPROVE DEPOSIT
// ======================================================

bot.on(  
    "callback_query",  
    async query => {  

        try {  

            const data =  
                String(  
                    query.data || ""  
                );  

            const chatId =  
                query.message &&  
                query.message.chat  
                    ? query.message.chat.id  
                    : null;  

            // --------------------------------------------  
            // SECURITY  
            // --------------------------------------------  

            if (  
                !isAdmin(chatId)  
            ) {  

                await bot.answerCallbackQuery(  
                    query.id,  
                    {  
                        text:  
                            "❌ Not authorized",  
                        show_alert: true  
                    }  
                );  

                return;  
            }  

            // --------------------------------------------  
            // APPROVE DEPOSIT  
            // --------------------------------------------  

            if (  
                data.startsWith(  
                    "approve_deposit:"  
                )  
            ) {  

                const id =  
                    integer(  
                        data.split(":")[1]  
                    );  

                if (!id) {  

                    await bot.answerCallbackQuery(  
                        query.id,  
                        {  
                            text:  
                                "Invalid deposit ID",  
                            show_alert: true  
                        }  
                    );  

                    return;  
                }  

                const deposit =  
                    approveDeposit(id);  

                // ----------------------------------------  
                // GET USER AFTER APPROVAL  
                // ----------------------------------------  

                const user =  
                    db.prepare(`  
                        SELECT  
                            telegram_id,  
                            balance,  
                            play_balance  
                        FROM users  
                        WHERE id = ?  
                    `).get(  
                        deposit.user_id  
                    );  

                // ----------------------------------------  
                // NOTIFY PLAYER  
                // ----------------------------------------  

                if (user) {  

                    await sendBotMessage(  

                        user.telegram_id,

`✅ Deposit Approved

Amount:
${num(deposit.amount)} ETB

🎮 Added to Play Wallet.

Main Wallet:
${num(user.balance)} ETB

Play Wallet:
${num(user.play_balance)} ETB`

);  
                }  

                await bot.answerCallbackQuery(  
                    query.id,  
                    {  
                        text:  
                            "✅ Deposit approved"  
                    }  
                );  

                // ----------------------------------------  
                // UPDATE ADMIN MESSAGE  
                // ----------------------------------------  

                try {  

                    await bot.editMessageReplyMarkup(  

                        {  
                            inline_keyboard: []  
                        },  

                        {  
                            chat_id:  
                                chatId,  

                            message_id:  
                                query.message.message_id  
                        }  

                    );  

                } catch (e) {  
                    // Message may already  
                    // have no keyboard.  
                }  

                return;  
            }  

            // --------------------------------------------  
            // REJECT DEPOSIT  
            // --------------------------------------------  

            if (  
                data.startsWith(  
                    "reject_deposit:"  
                )  
            ) {  

                const id =  
                    integer(  
                        data.split(":")[1]  
                    );  

                if (!id) {  

                    await bot.answerCallbackQuery(  
                        query.id,  
                        {  
                            text:  
                                "Invalid deposit ID",  
                            show_alert: true  
                        }  
                    );  

                    return;  
                }  

                const deposit =  
                    rejectDeposit(id);  

                // ----------------------------------------  
                // GET USER  
                // ----------------------------------------  

                const user =  
                    db.prepare(`  
                        SELECT  
                            telegram_id,  
                            balance,  
                            play_balance  
                        FROM users  
                        WHERE id = ?  
                    `).get(  
                        deposit.user_id  
                    );  

                // ----------------------------------------  
                // NOTIFY PLAYER  
                // ----------------------------------------  

                if (user) {  

                    await sendBotMessage(  

                        user.telegram_id,

`❌ Deposit Rejected

Amount:
${num(deposit.amount)} ETB

Reference:
${deposit.reference}

The amount was NOT added to your Play Wallet.

If you believe this was rejected by mistake, please contact the administrator.`

);  
                }  

                await bot.answerCallbackQuery(  
                    query.id,  
                    {  
                        text:  
                            "❌ Deposit rejected"  
                    }  
                );  

                try {  

                    await bot.editMessageReplyMarkup(  

                        {  
                            inline_keyboard: []  
                        },  

                        {  
                            chat_id:  
                                chatId,  

                            message_id:  
                                query.message.message_id  
                        }  

                    );  

                } catch (e) {  
                    // Ignore  
                }  

                return;  
            }  

            // --------------------------------------------  
            // APPROVE WITHDRAWAL  
            // --------------------------------------------  

            if (  
                data.startsWith(  
                    "approve_withdraw:"  
                )  
            ) {  

                const id =  
                    integer(  
                        data.split(":")[1]  
                    );  

                if (!id) {  

                    await bot.answerCallbackQuery(  
                        query.id,  
                        {  
                            text:  
                                "Invalid withdrawal ID",  
                            show_alert: true  
                        }  
                    );  

                    return;  
                }  

                const withdrawal =  
                    approveWithdrawal(id);  

                const user =  
                    db.prepare(`  
                        SELECT  
                            telegram_id,  
                            balance,  
                            play_balance  
                        FROM users  
                        WHERE id = ?  
                    `).get(  
                        withdrawal.user_id  
                    );  

                if (user) {  

                    await sendBotMessage(  

                        user.telegram_id,

`✅ Withdrawal Approved

Amount:
${num(withdrawal.amount)} ETB

Your withdrawal has been approved.

💰 Main Wallet:
${num(user.balance)} ETB

🎮 Play Wallet:
${num(user.play_balance)} ETB`

);  
                }  

                await bot.answerCallbackQuery(  
                    query.id,  
                    {  
                        text:  
                            "✅ Withdrawal approved"  
                    }  
                );  

                try {  

                    await bot.editMessageReplyMarkup(  

                        {  
                            inline_keyboard: []  
                        },  

                        {  
                            chat_id:  
                                chatId,  

                            message_id:  
                                query.message.message_id  
                        }  

                    );  

                } catch (e) {  
                    // Ignore  
                }  

                return;  
            }  

            // --------------------------------------------  
            // REJECT WITHDRAWAL  
            // --------------------------------------------  

            if (  
                data.startsWith(  
                    "reject_withdraw:"  
                )  
            ) {  

                const id =  
                    integer(  
                        data.split(":")[1]  
                    );  

                if (!id) {  

                    await bot.answerCallbackQuery(  
                        query.id,  
                        {  
                            text:  
                                "Invalid withdrawal ID",  
                            show_alert: true  
                        }  
                    );  

                    return;  
                }  

                const withdrawal =  
                    rejectWithdrawal(id);  

                const user =  
                    db.prepare(`  
                        SELECT  
                            telegram_id,  
                            balance,  
                            play_balance  
                        FROM users  
                        WHERE id = ?  
                    `).get(  
                        withdrawal.user_id  
                    );  

                if (user) {  

                    await sendBotMessage(  

                        user.telegram_id,

`❌ Withdrawal Rejected

Amount:
${num(withdrawal.amount)} ETB

The withdrawal was rejected.

💰 The amount has been returned to your Main Wallet.

Main Wallet:
${num(user.balance)} ETB`

);  
                }  

                await bot.answerCallbackQuery(  
                    query.id,  
                    {  
                        text:  
                            "❌ Withdrawal rejected and refunded"  
                    }  
                );  

                try {  

                    await bot.editMessageReplyMarkup(  

                        {  
                            inline_keyboard: []  
                        },  

                        {  
                            chat_id:  
                                chatId,  

                            message_id:  
                                query.message.message_id  
                        }  

                    );  

                } catch (e) {  
                    // Ignore  
                }  

                return;  
            }  

        } catch (error) {  

            console.error(  
                "CALLBACK ERROR:",  
                error  
            );  

            try {  

                await bot.answerCallbackQuery(  
                    query.id,  
                    {  
                        text:  
                            "❌ An error occurred",  
                        show_alert: true  
                    }  
                );  

            } catch (e) {  
                // Ignore  
            }  
        }  
    }  
);

// ======================================================
// BOT ERROR HANDLER
// ======================================================

bot.on(  
    "polling_error",  
    error => {  

        console.error(  
            "TELEGRAM POLLING ERROR:",  
            error.message  
        );  

    }  
);

}

// ======================================================
// ADMIN PENDING DEPOSITS COMMAND
// ======================================================

if (bot) {

bot.onText(  
    /^\/pendingdeposits$/,  
    async msg => {  

        if (  
            !isAdmin(  
                msg.chat.id  
            )  
        ) {  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Not authorized."  
            );  

            return;  
        }  

        const deposits =  
            db.prepare(`  
                SELECT  
                    d.id,  
                    d.amount,  
                    d.reference,  
                    d.created_at,  

                    u.telegram_id,  
                    u.username,  
                    u.first_name  

                FROM deposits d  

                JOIN users u  
                    ON u.id = d.user_id  

                WHERE d.status = 'pending'  

                ORDER BY d.id ASC  
            `).all();  

        if (  
            deposits.length === 0  
        ) {  

            await sendBotMessage(  
                msg.chat.id,  
                "✅ No pending deposits."  
            );  

            return;  
        }  

        for (  
            const deposit of deposits  
        ) {  

            const text =

`💳 PENDING DEPOSIT

Deposit ID:
${deposit.id}

Player:
${
deposit.first_name ||
"Unknown"
}

Username:
@${
deposit.username ||
"none"
}

Telegram ID:
${deposit.telegram_id}

Amount:
${num(deposit.amount)} ETB

Reference:
${deposit.reference}

Time:
${deposit.created_at}`;

await sendBotMessage(  

                msg.chat.id,  

                text,  

                {  
                    reply_markup: {  
                        inline_keyboard: [  

                            [  
                                {  
                                    text:  
                                        "✅ APPROVE",  
                                    callback_data:  
                                        `approve_deposit:${deposit.id}`  
                                },  

                                {  
                                    text:  
                                        "❌ REJECT",  
                                    callback_data:  
                                        `reject_deposit:${deposit.id}`  
                                }  
                            ]  

                        ]  
                    }  
                }  

            );  
        }  

    }  
);

// ======================================================
// ADMIN PENDING WITHDRAWALS COMMAND
// ======================================================

bot.onText(  
    /^\/pendingwithdrawals$/,  
    async msg => {  

        if (  
            !isAdmin(  
                msg.chat.id  
            )  
        ) {  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Not authorized."  
            );  

            return;  
        }  

        const withdrawals =  
            db.prepare(`  
                SELECT  
                    w.id,  
                    w.amount,  
                    w.account_details,  
                    w.created_at,  

                    u.telegram_id,  
                    u.username,  
                    u.first_name  

                FROM withdrawals w  

                JOIN users u  
                    ON u.id = w.user_id  

                WHERE w.status = 'pending'  

                ORDER BY w.id ASC  
            `).all();  

        if (  
            withdrawals.length === 0  
        ) {  

            await sendBotMessage(  
                msg.chat.id,  
                "✅ No pending withdrawals."  
            );  

            return;  
        }  

        for (  
            const withdrawal of withdrawals  
        ) {  

            const text =

`💸 PENDING WITHDRAWAL

Withdrawal ID:
${withdrawal.id}

Player:
${
withdrawal.first_name ||
"Unknown"
}

Username:
@${
withdrawal.username ||
"none"
}

Telegram ID:
${withdrawal.telegram_id}

Amount:
${num(withdrawal.amount)} ETB

Account Details:
${withdrawal.account_details}

Time:
${withdrawal.created_at}`;

await sendBotMessage(  

                msg.chat.id,  

                text,  

                {  
                    reply_markup: {  
                        inline_keyboard: [  

                            [  
                                {  
                                    text:  
                                        "✅ APPROVE",  
                                    callback_data:  
                                        `approve_withdraw:${withdrawal.id}`  
                                },  

                                {  
                                    text:  
                                        "❌ REJECT + REFUND",  
                                    callback_data:  
                                        `reject_withdraw:${withdrawal.id}`  
                                }  
                            ]  

                        ]  
                    }  
                }  

            );  
        }  

    }  
);

}

// ======================================================
// END OF PART 3
// ======================================================
// ======================================================
// ADMIN DATABASE SUMMARY
// ======================================================

if (bot) {

bot.onText(  
    /^\/admin$/,
    async msg => {  

        if (  
            !isAdmin(  
                msg.chat.id  
            )  
        ) {  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Not authorized."  
            );  

            return;  
        }  

        try {  

            const users =  
                db.prepare(`  
                    SELECT COUNT(*) AS count  
                    FROM users  
                `).get().count;  

            const pendingDeposits =  
                db.prepare(`  
                    SELECT COUNT(*) AS count  
                    FROM deposits  
                    WHERE status = 'pending'  
                `).get().count;  

            const pendingWithdrawals =  
                db.prepare(`  
                    SELECT COUNT(*) AS count  
                    FROM withdrawals  
                    WHERE status = 'pending'  
                `).get().count;  

            const waitingMatches =  
                db.prepare(`  
                    SELECT COUNT(*) AS count  
                    FROM matches  
                    WHERE status = 'WAITING'  
                `).get().count;  

            const playingMatches =  
                db.prepare(`  
                    SELECT COUNT(*) AS count  
                    FROM matches  
                    WHERE status = 'PLAYING'  
                `).get().count;  

            const finishedMatches =  
                db.prepare(`  
                    SELECT COUNT(*) AS count  
                    FROM matches  
                    WHERE status = 'FINISHED'  
                `).get().count;  

            await sendBotMessage(  

                msg.chat.id,

`🛠 FRICK BINGO ADMIN

👤 Users:
${users}

💳 Pending Deposits:
${pendingDeposits}

💸 Pending Withdrawals:
${pendingWithdrawals}

🎮 Waiting Games:
${waitingMatches}

▶️ Playing Games:
${playingMatches}

🏁 Finished Games:
${finishedMatches}`
);  

        } catch (error) {  

            console.error(  
                "/admin ERROR:",  
                error  
            );  

            await sendBotMessage(  
                msg.chat.id,  
                "❌ Could not load admin information."  
            );  
        }  

    }  
);

// ======================================================
// SERVER ROOT
// ======================================================

app.get(
"/",
(req, res) => {

res.sendFile(  
        path.join(  
            __dirname,  
            "public",  
            "index.html"  
        )  
    );  

}

);

// ======================================================
// 404 API HANDLER
// ======================================================

app.use(
"/api",
(req, res) => {

res.status(404).json({  

        success: false,  

        error:  
            "API endpoint not found",  

        path:  
            req.originalUrl  

    });  

}

);

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
(error, req, res, next) => {

console.error(  
        "GLOBAL ERROR:",  
        error  
    );  

    if (  
        res.headersSent  
    ) {  

        return next(  
            error  
        );  

    }  

    res.status(500).json({  

        success: false,  

        error:  
            "Internal server error"  

    });  
}

);

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

function shutdown(
signal
) {

console.log(  
    `\n⚠️ ${signal} received. Shutting down...`  
);  

try {  

    if (bot) {  

        bot.stopPolling();  

        console.log(  
            "✅ Telegram polling stopped"  
        );  
    }  

} catch (error) {  

    console.error(  
        "Bot shutdown error:",  
        error.message  
    );  

}  

try {  

    db.close();  

    console.log(  
        "✅ Database closed"  
    );  

} catch (error) {  

    console.error(  
        "Database shutdown error:",  
        error.message  
    );  

}  

process.exit(0);

}

process.on(
"SIGINT",
() => shutdown("SIGINT")
);

process.on(
"SIGTERM",
() => shutdown("SIGTERM")
);
// ======================================================
// START SERVER
// ======================================================

app.listen(PORT,"0.0.0.0",() => {
    console.log("");  
    console.log(  
        "======================================"  
    );  

    console.log(  
        "🎮 FRICK BINGO SERVER"  
    );  

    console.log(  
        "======================================"  
    );  

    console.log(  
        `🚀 Server running on port ${PORT}`  
    );  

    console.log(  
        `🌐 Web App: ${  
            WEB_APP_URL ||  
            "Not configured"  
        }  
    `);  

    console.log(  
        `💾 Database: ${  
            DATABASE_FILE  
        }`  
    );  

    console.log(  
        `💰 Stakes: ${  
            GAME_STAKES.join(", ")  
        } ETB`  
    );  

    console.log(  
        `🎟 Max Cards: ${  
            MAX_CARDS  
        }`  
    );  

    console.log(  
        `🏆 Prize Rate: ${  
            WIN_RATE * 100  
        }% of TOTAL MATCH COST`  
    );  

    console.log(  
        "👥 Players: 200+ supported"  
    );  

    console.log(  
        "🆔 Shared Game ID: ENABLED"  
    );  

    console.log(  
        "======================================"  
    );  

    console.log("");
})};
