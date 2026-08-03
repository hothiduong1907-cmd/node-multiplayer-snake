'use strict';
const path = require('path');
const GameController = require('./app/controllers/game-controller');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const { useAzureSocketIO } = require('@azure/web-pubsub-socket.io');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { CosmosClient } = require('@azure/cosmos');
if (process.env.WEB_PUBSUB_CONNECTION_STRING) {
    useAzureSocketIO(io, {
        hub: 'snakeHub',
        connectionString: process.env.WEB_PUBSUB_CONNECTION_STRING,
    });
    console.log('Web PubSub enabled — multi-instance sync active');
} else {
    console.log('Web PubSub connection string not found — running in single-instance mode');
}
const favicon = require('serve-favicon');
const lessMiddleware = require('less-middleware');

app.use(lessMiddleware(path.join(__dirname, 'public')));
// Expose all static resources in /public
app.use(express.static(path.join(__dirname, 'public')));
app.use(favicon(path.join(__dirname, 'public', 'favicon.png')));

// Redirect to the main page
app.get('/', (request, response) => {
    response.sendFile('game.html', { root: path.join(__dirname, 'app/views') });
});

// Create the main controller
const gameController = new GameController();
gameController.listen(io);
const KEY_VAULT_URL = 'https://kv-snake-1907.vault.azure.net/';
let cosmosContainer = null;
let secretsLoaded = false;

async function initAzureServices() {
    try {
        const credential = new DefaultAzureCredential();
        const secretClient = new SecretClient(KEY_VAULT_URL, credential);

        const appEnvSecret = await secretClient.getSecret('AppEnv');
        const cosmosKeySecret = await secretClient.getSecret('CosmosDbKey');
        const cosmosEndpointSecret = await secretClient.getSecret('CosmosDbEndpoint');

        console.log('Đã đọc secret AppEnv từ Key Vault:', appEnvSecret.value);
        secretsLoaded = true;

        const cosmosClient = new CosmosClient({
            endpoint: cosmosEndpointSecret.value,
            key: cosmosKeySecret.value,
        });
        const database = cosmosClient.database('SnakeDB');
        cosmosContainer = database.container('Leaderboard');
        console.log('Đã kết nối Cosmos DB thành công');
    } catch (error) {
        console.error('Lỗi khi kết nối Key Vault/Cosmos DB:', error.message);
    }
}

initAzureServices();

app.use(express.json());

app.get('/health', (request, response) => {
    response.json({
        status: 'ok',
        keyVaultSecretLoaded: secretsLoaded,
        cosmosConnected: cosmosContainer !== null,
    });
});

app.post('/api/score', async (request, response) => {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }
    const { playerName, score } = request.body;
    if (!playerName || score === undefined) {
        return response.status(400).json({ error: 'Thiếu playerName hoặc score' });
    }
    try {
        const item = { id: `${playerName}-${Date.now()}`, playerName, score, createdAt: new Date().toISOString() };
        await cosmosContainer.items.create(item);
        response.json({ success: true, item });
    } catch (error) {
        response.status(500).json({ error: error.message });
    }
});

app.get('/api/leaderboard', async (request, response) => {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }
    try {
        const { resources } = await cosmosContainer.items
            .query('SELECT TOP 10 * FROM c ORDER BY c.score DESC')
            .fetchAll();
        response.json(resources);
    } catch (error) {
        response.status(500).json({ error: error.message });
    }
});
const SERVER_PORT = process.env.PORT || 3000;
app.set('port', SERVER_PORT);

// Start Express server
server.listen(app.get('port'), () => {
    console.log('Express server listening on port %d in %s mode', app.get('port'), app.get('env'));
});

module.exports = app;
