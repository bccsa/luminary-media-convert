import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { UsersService } from './users.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UserDocument } from './interfaces/user-document.interface.js';

function toResponse(user: UserDocument): UserResponseDto {
    return {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}

@ApiTags('Admin - Users')
@ApiBearerAuth('auth0')
@Controller('saas/admin/users')
@UseGuards(JwtAuthGuard, AdminGuard)
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Post()
    async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
        const user = await this.usersService.create(dto);
        return toResponse(user);
    }

    @Get()
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'skip', required: false, type: Number })
    @ApiQuery({ name: 'search', required: false, type: String })
    @ApiQuery({ name: 'role', required: false, enum: ['user', 'admin'] })
    @ApiQuery({
        name: 'status',
        required: false,
        enum: ['active', 'disabled', 'pending_verification'],
    })
    async findAll(
        @Query('limit') limit?: number,
        @Query('skip') skip?: number,
        @Query('search') search?: string,
        @Query('role') role?: string,
        @Query('status') status?: string,
    ): Promise<{ users: UserResponseDto[]; total: number }> {
        const result = await this.usersService.findAll({
            limit,
            skip,
            search,
            role,
            status,
        });
        return {
            users: result.docs.map(toResponse),
            total: result.total,
        };
    }

    @Get(':userId')
    async findOne(
        @Param('userId') userId: string,
    ): Promise<UserResponseDto> {
        const user = await this.usersService.findById(userId);
        return toResponse(user);
    }

    @Patch(':userId')
    async update(
        @Param('userId') userId: string,
        @Body() dto: UpdateUserDto,
    ): Promise<UserResponseDto> {
        const user = await this.usersService.update(userId, dto);
        return toResponse(user);
    }

    @Post(':userId/disable')
    @HttpCode(HttpStatus.OK)
    async disable(
        @Param('userId') userId: string,
    ): Promise<UserResponseDto> {
        const user = await this.usersService.update(userId, {
            status: 'disabled',
        });
        return toResponse(user);
    }

    @Post(':userId/enable')
    @HttpCode(HttpStatus.OK)
    async enable(
        @Param('userId') userId: string,
    ): Promise<UserResponseDto> {
        const user = await this.usersService.update(userId, {
            status: 'active',
        });
        return toResponse(user);
    }

    @Delete(':userId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('userId') userId: string): Promise<void> {
        await this.usersService.remove(userId);
    }
}
