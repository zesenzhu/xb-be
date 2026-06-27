import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAppDto,
  UpdateAppDto,
  CreateAppFeatureDto,
  UpdateAppFeatureDto,
} from './dto/app.dto';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================
  // App (应用管理)
  // ==========================================

  async createApp(dto: CreateAppDto) {
    const existing = await this.prisma.app.findUnique({
      where: { appKey: dto.appKey },
    });
    if (existing) {
      throw new BadRequestException(
        `应用标识 appKey "${dto.appKey}" 已存在，请更换`,
      );
    }

    return this.prisma.app.create({
      data: {
        name: dto.name,
        appKey: dto.appKey,
        description: dto.description,
        status: dto.status ?? 1,
        dashboardPath: dto.dashboardPath,
      },
    });
  }

  async findAllApps() {
    return this.prisma.app.findMany({
      include: {
        features: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOneApp(id: string) {
    const app = await this.prisma.app.findUnique({
      where: { id },
      include: { features: true },
    });
    if (!app) {
      throw new NotFoundException(`未找到 ID 为 "${id}" 的应用`);
    }
    return app;
  }

  async updateApp(id: string, dto: UpdateAppDto) {
    await this.findOneApp(id);

    if (dto.appKey) {
      const existing = await this.prisma.app.findFirst({
        where: {
          appKey: dto.appKey,
          id: { not: id },
        },
      });
      if (existing) {
        throw new BadRequestException(
          `应用标识 appKey "${dto.appKey}" 已被其他应用使用`,
        );
      }
    }

    return this.prisma.app.update({
      where: { id },
      data: dto,
    });
  }

  async removeApp(id: string) {
    await this.findOneApp(id);
    return this.prisma.app.delete({
      where: { id },
    });
  }

  // ==========================================
  // AppFeature (功能点管理)
  // ==========================================

  async createFeature(appId: string, dto: CreateAppFeatureDto) {
    // 确保应用存在
    await this.findOneApp(appId);

    // 检查此应用下 code 是否重复
    const existing = await this.prisma.appFeature.findUnique({
      where: {
        appId_code: {
          appId,
          code: dto.code,
        },
      },
    });
    if (existing) {
      throw new BadRequestException(`该应用下已存在功能标识 "${dto.code}"`);
    }

    return this.prisma.appFeature.create({
      data: {
        appId,
        name: dto.name,
        code: dto.code,
        description: dto.description,
      },
    });
  }

  async findFeaturesByApp(appId: string) {
    await this.findOneApp(appId);
    return this.prisma.appFeature.findMany({
      where: { appId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateFeature(featureId: string, dto: UpdateAppFeatureDto) {
    const feature = await this.prisma.appFeature.findUnique({
      where: { id: featureId },
    });
    if (!feature) {
      throw new NotFoundException(`未找到 ID 为 "${featureId}" 的功能点`);
    }

    if (dto.code && dto.code !== feature.code) {
      const existing = await this.prisma.appFeature.findUnique({
        where: {
          appId_code: {
            appId: feature.appId,
            code: dto.code,
          },
        },
      });
      if (existing) {
        throw new BadRequestException(`该应用下已存在功能标识 "${dto.code}"`);
      }
    }

    return this.prisma.appFeature.update({
      where: { id: featureId },
      data: dto,
    });
  }

  async removeFeature(featureId: string) {
    const feature = await this.prisma.appFeature.findUnique({
      where: { id: featureId },
    });
    if (!feature) {
      throw new NotFoundException(`未找到 ID 为 "${featureId}" 的功能点`);
    }

    return this.prisma.appFeature.delete({
      where: { id: featureId },
    });
  }
}
