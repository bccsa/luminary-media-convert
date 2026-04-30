import nano from 'nano';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

function parseArgs(args: string[]): { email: string; name: string } {
    let email = '';
    let name = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--email' && args[i + 1]) {
            email = args[i + 1];
            i++;
        } else if (args[i] === '--name' && args[i + 1]) {
            name = args[i + 1];
            i++;
        }
    }

    if (!email || !name) {
        console.error('Usage: tsx scripts/seed-admin.ts --email <email> --name <name>');
        process.exit(1);
    }

    return { email, name };
}

async function main() {
    const { email, name } = parseArgs(process.argv.slice(2));

    const couchdbUrl = process.env.COUCHDB_URL || 'http://localhost:5984';
    const dbName = process.env.COUCHDB_DATABASE || 'luminary';

    const server = nano(couchdbUrl);

    // Create database if needed
    try {
        await server.db.get(dbName);
    } catch (err: any) {
        if (err.statusCode === 404) {
            await server.db.create(dbName);
            console.log(`Database '${dbName}' created`);
        } else {
            throw err;
        }
    }

    const db = server.db.use(dbName);

    // Check if user with this email already exists
    const existing = await db.find({
        selector: { docType: 'user', email },
        limit: 1,
    });

    if (existing.docs.length > 0) {
        console.error(`Error: User with email '${email}' already exists`);
        process.exit(1);
    }

    const now = new Date().toISOString();
    const id = `user:${uuidv4()}`;

    await db.insert({
        _id: id,
        docType: 'user',
        auth0Id: null,
        email,
        name,
        role: 'admin',
        status: 'active',
        sessionRetentionDaysOverride: null,
        emailVerifiedAt: now,
        invitedBy: null,
        onboardingCompletedAt: null,
        lastLoginAt: null,
        lastApiAccessAt: null,
        createdAt: now,
        updatedAt: now,
    });

    console.log(`Admin user created successfully:`);
    console.log(`  ID:    ${id}`);
    console.log(`  Email: ${email}`);
    console.log(`  Name:  ${name}`);
    console.log(`  Role:  admin`);
}

main().catch((err) => {
    console.error('Failed to seed admin user:', err);
    process.exit(1);
});
