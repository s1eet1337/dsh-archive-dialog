import type { HostContext } from './context.ts';
/** Plugin identity for the cordis.patch.yml row (and the client bundle id). */
export declare const name = "dsh-archive-dialog";
/** webServer 硬依赖：loader 会等服务出现后再 apply，路由注册不会和启动顺序赛跑。
 *  其余服务按需懒读（bundle 行常早于兄弟服务行挂载）。 */
export declare const inject: string[];
export declare function apply(ctx: HostContext): void;
