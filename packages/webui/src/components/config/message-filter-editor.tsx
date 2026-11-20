// Message filter rules editor — shared by the account-level config tab and
// the per-adapter override section in the node edit dialog. Edits a
// MessageFilterConfig in place through onChange; "default" modes only appear
// when allowDefault is set (per-adapter overrides), mirroring the server's
// inheritance chain: section 'default' → account counterpart → base message.

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DropdownSelect, type DropdownOption } from '@/components/ui/dropdown-select';
import {
    makeDefaultMessageFilterConfig,
    normalizeMessageFilterConfig,
} from '@/components/config/defaults';
import type {
    MessageFilterConfig,
    MessageFilterContentConfig,
    MessageFilterIdConfig,
    MessageFilterOutputConfig,
} from '@/types';

type IdMode = MessageFilterIdConfig['mode'];
type ContentMode = MessageFilterContentConfig['mode'];
type OutputMode = MessageFilterOutputConfig['mode'];

const idModeOptions = (allowDefault: boolean): ReadonlyArray<DropdownOption<IdMode>> => [
    ...(allowDefault ? [{ value: 'default' as const, label: '跟随账号默认' }] : []),
    { value: 'on', label: '不限制' },
    { value: 'off', label: '全部屏蔽' },
    { value: 'whitelist', label: '白名单' },
    { value: 'blacklist', label: '黑名单' },
];

const contentModeOptions = (allowDefault: boolean): ReadonlyArray<DropdownOption<ContentMode>> => [
    ...(allowDefault ? [{ value: 'default' as const, label: '跟随账号默认' }] : []),
    { value: 'on', label: '不限制' },
    { value: 'off', label: '全部拦截' },
    { value: 'whitelist', label: '白名单' },
    { value: 'blacklist', label: '黑名单' },
];

const outputModeOptions = (allowDefault: boolean): ReadonlyArray<DropdownOption<OutputMode>> => [
    ...(allowDefault ? [{ value: 'default' as const, label: '跟随账号默认' }] : []),
    { value: 'on', label: '不限制' },
    { value: 'off', label: '全部拦截' },
    { value: 'blacklist', label: '黑名单' },
];

function parseIds(text: string): number[] {
    const seen = new Set<number>();
    const out: number[] = [];

    for (const part of text.split(/[\s,，;；]+/)) {
        const num = Number(part);

        if (Number.isSafeInteger(num) && num > 0 && !seen.has(num)) {
            seen.add(num);
            out.push(num);
        }
    }

    return out;
}

function formatIds(ids: number[]): string {
    return ids.join(', ');
}

function parseLines(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
}

interface MessageFilterEditorProps {
    value: MessageFilterConfig | undefined;
    onChange: (next: MessageFilterConfig) => void;
    /** Show 'default' inheritance options (per-adapter overrides). */
    allowDefault?: boolean;
}

export function MessageFilterEditor({
    value,
    onChange,
    allowDefault = false,
}: MessageFilterEditorProps) {
    const uid = useId();
    const config = normalizeMessageFilterConfig(value);

    const patch = (section: Partial<MessageFilterConfig>) => onChange({ ...config, ...section });

    return (
        <div className="flex flex-col gap-4">
            <IdSection
                label="QQ 黑白名单"
                desc="按发送者 QQ 号过滤私聊与群消息；群消息同时受群名单约束"
                section={config.userId}
                onChange={(userId) => patch({ userId })}
                allowDefault={allowDefault}
                keyHint={`${uid}-user`}
            />
            <IdSection
                label="群号黑白名单"
                desc="只影响群消息；白名单外的群全部丢弃"
                section={config.groupId}
                onChange={(groupId) => patch({ groupId })}
                allowDefault={allowDefault}
                keyHint={`${uid}-group`}
            />
            <ContentSection
                label="私聊消息规则"
                desc="正则匹配消息文本；命中前缀直接放行并改写"
                section={config.privateMessage}
                base={config.message}
                onChange={(privateMessage) => patch({ privateMessage })}
                allowDefault={allowDefault}
                keyHint={`${uid}-private`}
            />
            <ContentSection
                label="群消息规则"
                desc="正则匹配消息文本；命中前缀直接放行并改写"
                section={config.groupMessage}
                base={config.message}
                onChange={(groupMessage) => patch({ groupMessage })}
                allowDefault={allowDefault}
                keyHint={`${uid}-group-msg`}
            />
            <OutputSection
                section={config.outputMessage}
                onChange={(outputMessage) => patch({ outputMessage })}
                allowDefault={allowDefault}
                keyHint={`${uid}-output`}
            />
            <RemoveAtsSection
                removeAts={config.removeAts}
                onChange={(removeAts) => patch({ removeAts })}
                keyHint={`${uid}-ats`}
            />
        </div>
    );
}

interface IdSectionProps {
    label: string;
    desc: string;
    section: MessageFilterIdConfig;
    onChange: (next: MessageFilterIdConfig) => void;
    allowDefault: boolean;
    keyHint: string;
}

function IdSection({ label, desc, section, onChange, allowDefault, keyHint }: IdSectionProps) {
    return (
        <div className="flex flex-col gap-3 rounded-lg border bg-card/40 p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <Label>{label}</Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
                </div>
                <DropdownSelect
                    className="w-32 shrink-0"
                    ariaLabel={label}
                    value={section.mode}
                    options={idModeOptions(allowDefault)}
                    onChange={(mode) => onChange({ ...section, mode })}
                />
            </div>
            {(section.mode === 'whitelist' || section.mode === 'blacklist') && (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                    <Label htmlFor={`${keyHint}-ids`}>QQ / 群号列表</Label>
                    <Input
                        id={`${keyHint}-ids`}
                        className="w-full font-mono tabular-nums"
                        value={formatIds(section.ids)}
                        placeholder="10001, 10002"
                        onChange={(e) => onChange({ ...section, ids: parseIds(e.target.value) })}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        逗号 / 空格分隔的正整数。
                    </p>
                </div>
            )}
        </div>
    );
}

interface ContentSectionProps {
    label: string;
    desc: string;
    section: MessageFilterContentConfig;
    /** Base `message` section shown when this section is 'default'. */
    base: MessageFilterContentConfig;
    onChange: (next: MessageFilterContentConfig) => void;
    allowDefault: boolean;
    keyHint: string;
}

function ContentSection({
    label,
    desc,
    section,
    base,
    onChange,
    allowDefault,
    keyHint,
}: ContentSectionProps) {
    const effective = section.mode === 'default' ? base : section;

    return (
        <div className="flex flex-col gap-3 rounded-lg border bg-card/40 p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <Label>{label}</Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {section.mode === 'default' ? '继承「通用消息规则」设置。' : desc}
                    </p>
                </div>
                <DropdownSelect
                    className="w-32 shrink-0"
                    ariaLabel={label}
                    value={section.mode}
                    options={contentModeOptions(allowDefault)}
                    onChange={(mode) => onChange({ ...section, mode })}
                />
            </div>
            {section.mode !== 'default' && (
                <div className="flex flex-col gap-3 border-t pt-3">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${keyHint}-filters`}>正则规则（每行一条）</Label>
                        <textarea
                            id={`${keyHint}-filters`}
                            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                            rows={3}
                            spellCheck={false}
                            value={effective.filters.join('\n')}
                            placeholder={'^/\n广告'}
                            onChange={(e) =>
                                onChange({ ...section, filters: parseLines(e.target.value) })
                            }
                        />
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            逐条匹配每个文本段。黑名单：命中即丢弃；白名单：全部未命中才丢弃。
                        </p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${keyHint}-prefix`}>免过滤前缀（每行一条）</Label>
                        <textarea
                            id={`${keyHint}-prefix`}
                            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                            rows={2}
                            spellCheck={false}
                            value={effective.prefix.join('\n')}
                            placeholder={'#'}
                            onChange={(e) =>
                                onChange({ ...section, prefix: parseLines(e.target.value) })
                            }
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${keyHint}-replace`}>前缀替换为</Label>
                        <Input
                            id={`${keyHint}-replace`}
                            className="w-full font-mono"
                            value={effective.prefixReplace}
                            placeholder="留空即删除前缀"
                            onChange={(e) =>
                                onChange({ ...section, prefixReplace: e.target.value })
                            }
                        />
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            命中前缀的消息直接放行，前缀被替换（只影响投递，本地历史保留原文）。
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

interface OutputSectionProps {
    section: MessageFilterOutputConfig;
    onChange: (next: MessageFilterOutputConfig) => void;
    allowDefault: boolean;
    keyHint: string;
}

function OutputSection({ section, onChange, allowDefault, keyHint }: OutputSectionProps) {
    return (
        <div className="flex flex-col gap-3 rounded-lg border bg-card/40 p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <Label>出站消息拦截</Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        过滤该来源的 send_msg / send_private_msg / send_group_msg；命中的动作返回
                        retcode 100 失败。
                    </p>
                </div>
                <DropdownSelect
                    className="w-32 shrink-0"
                    ariaLabel="出站消息拦截"
                    value={section.mode}
                    options={outputModeOptions(allowDefault)}
                    onChange={(mode) => onChange({ ...section, mode })}
                />
            </div>
            {section.mode === 'blacklist' && (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                    <Label htmlFor={`${keyHint}-output-filters`}>正则规则（每行一条）</Label>
                    <textarea
                        id={`${keyHint}-output-filters`}
                        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                        rows={3}
                        spellCheck={false}
                        value={section.filters.join('\n')}
                        onChange={(e) =>
                            onChange({ ...section, filters: parseLines(e.target.value) })
                        }
                    />
                </div>
            )}
        </div>
    );
}

interface RemoveAtsSectionProps {
    removeAts: string[];
    onChange: (next: string[]) => void;
    keyHint: string;
}

function RemoveAtsSection({ removeAts, onChange, keyHint }: RemoveAtsSectionProps) {
    return (
        <div className="flex flex-col gap-3 rounded-lg border bg-card/40 p-4">
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${keyHint}-ats`}>移除 @ 段（QQ 号，每行一个）</Label>
                <textarea
                    id={`${keyHint}-ats`}
                    className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                    rows={2}
                    spellCheck={false}
                    value={removeAts.join('\n')}
                    placeholder="131415"
                    onChange={(e) => onChange(parseLines(e.target.value))}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                    从投递的消息中删除这些 QQ 号的 @ 段（只影响投递，本地历史保留原文）。
                </p>
            </div>
        </div>
    );
}

/** Reset helper exposed for the account tab's "恢复默认" action. */
export function defaultMessageFilterConfig(): MessageFilterConfig {
    return makeDefaultMessageFilterConfig();
}
