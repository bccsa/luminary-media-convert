import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';

@ApiTags('Identity')
@ApiBearerAuth('auth0')
@Controller('saas/me')
@UseGuards(JwtAuthGuard)
export class MeController {
    @Get()
    me(@Req() req: { user: { _id: string; email: string; name: string; role: string; status: string } }) {
        return {
            id: req.user._id,
            email: req.user.email,
            name: req.user.name,
            role: req.user.role,
            status: req.user.status,
        };
    }
}
