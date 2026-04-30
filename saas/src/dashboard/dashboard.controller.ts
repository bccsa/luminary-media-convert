import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('Admin - Dashboard')
@ApiBearerAuth('auth0')
@Controller('saas/admin/dashboard')
@UseGuards(JwtAuthGuard, AdminGuard)
export class DashboardController {
    constructor(private readonly dashboardService: DashboardService) {}

    @Get()
    async getStats() {
        return this.dashboardService.getStats();
    }
}
