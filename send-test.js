const { ServiceBusClient } = require("@azure/service-bus");

const connectionString = "DÁN_PRIMARY_CONNECTION_STRING";
const queueName = "game-events";

async function main() {
    const client = new ServiceBusClient(connectionString);

    const sender = client.createSender(queueName);

    await sender.sendMessages({
        body: {
            player: "Dung",
            event: "join_game",
            score: 0,
            time: new Date().toISOString()
        }
    });

    console.log("Message đã được gửi.");

    await sender.close();
    await client.close();
}

main().catch(console.error);
