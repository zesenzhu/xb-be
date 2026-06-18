import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

// 确保存储目录物理存在
const uploadDir = join(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

@ApiTags('Upload 资源上传')
@Controller('upload')
@UseGuards(JwtAuthGuard) // ⚠️ 接口全局绑定安全鉴权卫士，拦截未登录攻击
export class UploadController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/avatars',
        filename: (
          req: any,
          file: Express.Multer.File,
          callback: (error: Error | null, filename: string) => void,
        ) => {
          const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = extname(file.originalname);
          callback(null, `avatar-${uniqueSuffix}${ext}`);
        },
      }),
      limits: {
        fileSize: 10 * 1024 * 1024, // ⚠️ 上传大小放宽至 10MB
      },
      fileFilter: (
        req: any,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
          return callback(
            new BadRequestException(
              '只允许上传 JPG/JPEG/PNG/GIF/WEBP 格式的图片文件！',
            ),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  @ApiOperation({
    summary: '上传用户头像',
    description:
      '上传本地图片作为用户头像，文件大小限制为 10MB，格式限 JPG/PNG/GIF/WEBP。只有已登录的管理员和操作员才能调用。',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: '上传成功，返回文件相对访问地址，并自动清理旧文件且入库更新',
  })
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('请上传有效的图片文件');
    }

    const userId = req.user?.sub as string;
    if (!userId) {
      throw new BadRequestException('身份认证凭证解析异常，无法绑定用户！');
    }

    // 1. 查询当前用户的原有 avatar 字段
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    // 2. 如果存在本地物理老头像，将其安全地从磁盘中物理删除
    if (user && user.avatar && user.avatar.startsWith('/uploads/')) {
      const relativePath = user.avatar.startsWith('/')
        ? user.avatar.substring(1)
        : user.avatar;
      const oldFilePath = join(process.cwd(), relativePath);
      if (fs.existsSync(oldFilePath)) {
        try {
          fs.unlinkSync(oldFilePath);
        } catch (err) {
          console.error(
            `[Upload] 物理清除旧头像文件 [${oldFilePath}] 失败:`,
            err,
          );
        }
      }
    }

    const filename = file.filename;
    const newUrl = `/uploads/avatars/${filename}`;

    // 3. 秒级入库：直接更新当前用户的数据库 avatar 字段，实现绝对一致性
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: newUrl },
    });

    return {
      success: true,
      url: newUrl,
    };
  }
}
