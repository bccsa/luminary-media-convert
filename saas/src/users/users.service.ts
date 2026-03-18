import {
    Injectable,
    NotFoundException,
    ConflictException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../database/database.service.js';
import { UserDocument } from './interfaces/user-document.interface.js';
import { CreateUserDto } from './dto/create-user.dto.js';

@Injectable()
export class UsersService {
    constructor(private readonly databaseService: DatabaseService) {}

    async create(dto: CreateUserDto): Promise<UserDocument> {
        const existing = await this.findByEmail(dto.email);
        if (existing) {
            throw new ConflictException(
                `User with email '${dto.email}' already exists`,
            );
        }

        const id = `user:${uuidv4()}`;
        const now = new Date().toISOString();

        const doc: UserDocument = {
            _id: id,
            docType: 'user',
            auth0Id: null,
            email: dto.email,
            name: dto.name,
            role: dto.role || 'user',
            status: 'active',
            sessionRetentionDaysOverride: null,
            emailVerifiedAt: now,
            invitedBy: null,
            onboardingCompletedAt: null,
            lastLoginAt: null,
            lastApiAccessAt: null,
            createdAt: now,
            updatedAt: now,
        };

        await this.databaseService.insert(doc);
        return doc;
    }

    async findByEmail(email: string): Promise<UserDocument | null> {
        const result = await this.databaseService.find<UserDocument>({
            selector: { docType: 'user', email },
            use_index: 'users-by-email',
            limit: 1,
        });

        return result.docs[0] || null;
    }

    async findByAuth0Id(auth0Id: string): Promise<UserDocument | null> {
        const result = await this.databaseService.find<UserDocument>({
            selector: { docType: 'user', auth0Id },
            use_index: 'users-by-auth0id',
            limit: 1,
        });

        return result.docs[0] || null;
    }

    async findById(id: string): Promise<UserDocument> {
        try {
            return await this.databaseService.get<UserDocument>(id);
        } catch (err: any) {
            if (err.statusCode === 404) {
                throw new NotFoundException(`User '${id}' not found`);
            }
            throw err;
        }
    }

    async findAll(opts: {
        limit?: number;
        skip?: number;
        search?: string;
        role?: string;
        status?: string;
    }): Promise<{ docs: UserDocument[]; total: number }> {
        const selector: Record<string, any> = { docType: 'user' };

        if (opts.role) {
            selector.role = opts.role;
        }
        if (opts.status) {
            selector.status = opts.status;
        }
        if (opts.search) {
            selector['$or'] = [
                { email: { $regex: `(?i)${opts.search}` } },
                { name: { $regex: `(?i)${opts.search}` } },
            ];
        }

        const result = await this.databaseService.find<UserDocument>({
            selector,
            limit: opts.limit || 25,
            skip: opts.skip || 0,
        });

        return { docs: result.docs, total: result.docs.length };
    }

    async update(
        id: string,
        updates: Partial<UserDocument>,
    ): Promise<UserDocument> {
        const existing = await this.findById(id);
        const now = new Date().toISOString();

        const updated = {
            ...existing,
            ...updates,
            _id: existing._id,
            _rev: existing._rev,
            docType: existing.docType,
            updatedAt: now,
        } as UserDocument;

        const response = await this.databaseService.insert(updated);
        updated._rev = response.rev;

        return updated;
    }

    async remove(id: string): Promise<void> {
        const existing = await this.findById(id);
        await this.databaseService.destroy(existing._id, existing._rev!);
    }

    async linkAuth0Id(id: string, auth0Id: string): Promise<void> {
        await this.update(id, { auth0Id } as Partial<UserDocument>);
    }
}
