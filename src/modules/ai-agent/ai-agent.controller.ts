import { Controller, Post, Body, Sse, MessageEvent } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';
import { Observable, map } from 'rxjs';

export interface ChatMessageInput {
  role?: string;
  sender?: string;
  content: string;
}

@Controller('ai-agent')
export class AiAgentController {
  constructor(private readonly aiAgentService: AiAgentService) {}

  /**
   * SSE 流式 AI 交互通道
   * 支持客户端以 POST 方式提交上下文，返回 Server-Sent Events 报文
   */
  @Post('chat-stream')
  @Sse('chat-stream')
  chatStream(
    @Body() body: { model: string; messages: ChatMessageInput[]; temperature: number },
  ): Observable<MessageEvent> {
    const { model, messages, temperature } = body;
    
    // 调用 Service 逻辑，并通过 RxJS Pipe 转换为 NestJS 的 MessageEvent 格式
    return this.aiAgentService.runChatStream(model, messages, temperature).pipe(
      map((msg) => ({
        type: msg.event, // 作为 SSE 事件名推送（前端 EventSource / ReadStream 会据此匹配）
        data: msg.data,
      } as MessageEvent)),
    );
  }
}
