import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { Observable } from 'rxjs';

@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor() {}

  /**
   * 动态获取大模型 OpenAI 实例
   * 根据传入的模型 ID 前缀（例如 deepseek 或 qwen）决定使用哪套 Key 与 BaseURL
   */
  private getClient(model: string): { openai: OpenAI; resolvedModel: string } {
    const modelLower = model.toLowerCase();

    // 默认回退设置
    let apiKey = process.env.DEEPSEEK_API_KEY;
    let baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    let resolvedModel = model;

    if (modelLower.startsWith('qwen')) {
      // 切换为阿里通义千问配置
      apiKey = process.env.DASHSCOPE_API_KEY;
      baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      this.logger.log(`[AI Factory] 路由至阿里通义千问大模型: ${model}`);
    } else {
      this.logger.log(`[AI Factory] 路由至 DeepSeek 官方大模型: ${model}`);
    }

    if (!apiKey) {
      throw new Error(`系统尚未配置模型厂商的 API Key，请先在 backend/.env 中配置对应环境变量！`);
    }

    const openai = new OpenAI({
      apiKey,
      baseURL,
    });

    return { openai, resolvedModel };
  }

  /**
   * 运行大模型流式对话，并生成 RxJS Observable 供 SSE 控制器使用
   */
  runChatStream(
    model: string,
    messages: any[],
    temperature: number,
  ): Observable<any> {
    return new Observable((subscriber) => {
      (async () => {
        try {
          // 1. 动态生成客户端实例
          const { openai, resolvedModel } = this.getClient(model);

          // 2. 声明系统内置物理工具集 (Function Calling)
          const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
            {
              type: 'function',
              function: {
                name: 'reboot_device',
                description: '强制重启或重置指定 MAC 地址的物理机器人设备。当设备过热或死机时使用。',
                parameters: {
                  type: 'object',
                  properties: {
                    mac: { type: 'string', description: '设备的 MAC 地址，例如 08:A3:E2:0F:91:BD' },
                    reason: { type: 'string', description: '重启的物理触发原因说明' },
                  },
                  required: ['mac'],
                },
              },
            },
          ];

          // 格式化输入消息以符合 OpenAI 官方 API 格式
          const apiMessages = messages.map((m) => ({
            role: m.role || m.sender,
            content: m.content || '',
          }));

          this.logger.log(`[LLM Call] 发起流式推理. Model: ${resolvedModel}, Temp: ${temperature}`);

          // 3. 调用 API (开启 stream: true)
          const stream = await openai.chat.completions.create({
            model: resolvedModel,
            messages: apiMessages as any,
            temperature: temperature,
            tools: tools,
            tool_choice: 'auto',
            stream: true,
          });

          let currentToolCalls: any[] = [];

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            // 情况 A：处理思考链 (DeepSeek-R1 专属字段 reasoning_content)
            const reasoning = (delta as any).reasoning_content;
            if (reasoning) {
              subscriber.next({ event: 'think', data: reasoning });
              continue;
            }

            // 情况 B：处理正文内容回复
            if (delta.content) {
              subscriber.next({ event: 'message', data: delta.content });
            }

            // 情况 C：处理工具调用 (Function Call) 缓存
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!currentToolCalls[tc.index]) {
                  currentToolCalls[tc.index] = {
                    id: tc.id,
                    name: tc.function?.name,
                    arguments: '',
                  };
                }
                if (tc.function?.arguments) {
                  currentToolCalls[tc.index].arguments += tc.function.arguments;
                }
              }
            }
          }

          // 4. 判断本轮交互是否命中了工具调用
          const activeToolCalls = currentToolCalls.filter(Boolean);
          if (activeToolCalls.length > 0) {
            for (const toolCall of activeToolCalls) {
              const args = JSON.parse(toolCall.arguments || '{}');
              this.logger.log(`[Agent Tool] 判定触发本地函数: ${toolCall.name}, 参数: ${toolCall.arguments}`);

              // 推送步骤开始通知到前端
              subscriber.next({
                event: 'step',
                data: JSON.stringify({
                  title: `匹配工具: ${toolCall.name}`,
                  description: `正在以参数参数执行: ${JSON.stringify(args)}`,
                  status: 'process',
                }),
              });

              // 物理执行本地方法
              let toolResult = '';
              if (toolCall.name === 'reboot_device') {
                toolResult = await this.executeRebootDevice(args.mac, args.reason);
              } else {
                toolResult = `未找到名为 ${toolCall.name} 的内置函数执行机制。`;
              }

              // 推送步骤完成通知到前端
              subscriber.next({
                event: 'step',
                data: JSON.stringify({
                  title: `物理执行: ${toolCall.name}`,
                  description: `执行成功: ${toolResult}`,
                  status: 'finish',
                }),
              });

              // 5. 将工具的物理执行结果回填大模型，生成第二轮的总结回答
              this.logger.log(`[LLM Call] 工具执行完毕，回填结果生成第二轮最终总结。`);
              const finalResponse = await openai.chat.completions.create({
                model: resolvedModel,
                messages: [
                  ...apiMessages,
                  {
                    role: 'assistant',
                    content: null,
                    tool_calls: activeToolCalls.map((tc) => ({
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.name, arguments: tc.arguments },
                    })),
                  } as any,
                  {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: toolResult,
                  } as any,
                ],
              });

              const finalAnswer = finalResponse.choices[0]?.message?.content || '物理控制指令已在后端物理链路完成！';
              subscriber.next({ event: 'message', data: finalAnswer });
            }
          }

          // 6. 宣告传输完毕，前端接收 close 事件断开连接
          subscriber.next({ event: 'close', data: 'done' });
          subscriber.complete();
        } catch (error) {
          this.logger.error('大模型流式调用遭遇致命异常', error);
          subscriber.next({ event: 'error', data: error.message || '内部服务异常' });
          subscriber.error(error);
        }
      })();
    });
  }

  /**
   * 模拟物理重启设备方法
   */
  private async executeRebootDevice(mac: string, reason: string): Promise<string> {
    this.logger.warn(`[Tool Execute] 触发物理重启命令. MAC: ${mac}, 原因: ${reason || '未提供原因'}`);
    
    // 延迟 1 秒模拟真实物理设备交互
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    return `设备 [ ${mac} ] 硬件重启指令已成功投递至 MQTT 控制 Topic。目前设备状态：已离线，预计于 15 秒后完成固件热重载并上报最新心跳。`;
  }
}
