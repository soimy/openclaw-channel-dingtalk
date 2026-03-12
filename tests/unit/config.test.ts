import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveGroupConfig, resolveRelativePath, stripTargetPrefix } from '../../src/config';

describe('config helpers', () => {
    describe('stripTargetPrefix', () => {
        it('strips explicit target prefixes correctly', () => {
            expect(stripTargetPrefix('group:cid123')).toEqual({ targetId: 'cid123', isExplicitUser: false });
            expect(stripTargetPrefix('user:user_1')).toEqual({ targetId: 'user_1', isExplicitUser: true });
            expect(stripTargetPrefix('raw_target')).toEqual({ targetId: 'raw_target', isExplicitUser: false });
        });
    });

    describe('resolveGroupConfig', () => {
        it('resolves group config with exact match then wildcard fallback', () => {
            const cfg = {
                groups: {
                    cid_exact: { systemPrompt: 'exact prompt' },
                    '*': { systemPrompt: 'fallback prompt' },
                },
            } as any;

            expect(resolveGroupConfig(cfg, 'cid_exact')).toEqual({ systemPrompt: 'exact prompt' });
            expect(resolveGroupConfig(cfg, 'cid_unknown')).toEqual({ systemPrompt: 'fallback prompt' });
        });

        it('returns undefined when no groups config exists', () => {
            const cfg = {} as any;
            expect(resolveGroupConfig(cfg, 'cid_any')).toBeUndefined();
        });
    });

    describe('resolveRelativePath', () => {
        let originalCwd: string;
        let originalPlatform: NodeJS.Platform;

        beforeEach(() => {
            originalCwd = process.cwd();
            originalPlatform = process.platform;
        });

        afterEach(() => {
            // Restore original values
            Object.defineProperty(process, 'cwd', { value: () => originalCwd });
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        });

        describe('empty and whitespace handling', () => {
            it('returns empty string for empty input', () => {
                expect(resolveRelativePath('')).toBe('');
            });

            it('returns trimmed string for whitespace-only input', () => {
                expect(resolveRelativePath('   ')).toBe('');
            });

            it('trims leading and trailing whitespace', () => {
                const result = resolveRelativePath('  test.txt  ');
                expect(result).not.toContain('  ');
                expect(result.endsWith('test.txt')).toBe(true);
            });
        });

        describe('home directory expansion', () => {
            it('expands bare ~ to home directory', () => {
                const result = resolveRelativePath('~');
                expect(result).toBe(os.homedir());
            });

            it('expands ~/ to home directory', () => {
                const result = resolveRelativePath('~/file.txt');
                const expected = path.resolve(os.homedir(), 'file.txt');
                expect(result).toBe(expected);
            });

            it('expands ~\\ to home directory (Windows)', () => {
                const result = resolveRelativePath('~\\file.txt');
                const expected = path.resolve(os.homedir(), 'file.txt');
                expect(result).toBe(expected);
            });

            it('handles nested paths after ~/', () => {
                const result = resolveRelativePath('~/subdir/file.txt');
                const expected = path.resolve(os.homedir(), 'subdir', 'file.txt');
                expect(result).toBe(expected);
            });
        });

        describe('Windows absolute paths', () => {
            beforeEach(() => {
                Object.defineProperty(process, 'platform', {
                    configurable: true,
                    value: 'win32',
                });
            });

            it('resolves Windows path with drive letter and backslash', () => {
                const result = resolveRelativePath('C:\\Users\\test\\file.txt');
                expect(result).toMatch(/^[A-Z]:\\/); // Has drive letter and absolute path
                expect(result).toContain('C:');
                expect(result.endsWith('file.txt')).toBe(true);
            });

            it('resolves Windows path with drive letter and forward slash', () => {
                const result = resolveRelativePath('C:/Users/test/file.txt');
                expect(result).toMatch(/^[A-Z]:\\/); // Normalized to backslashes on Windows
                expect(result).toContain('C:');
            });

            it('handles Windows path without leading backslash (OpenClaw compatibility)', () => {
                // This is the main fix for the Windows bug
                // Simulating: Users\username\.openclaw\workspace\file.xlsx
                const result = resolveRelativePath('Users\\testuser\\.openclaw\\workspace\\file.xlsx');

                // Should be treated as absolute path from root, not relative
                expect(result).not.toContain('workspace\\Users'); // No duplication
                expect(result.endsWith('file.xlsx')).toBe(true);
            });

            it('handles Windows path with dot in second segment', () => {
                // Pattern: Directory\username\.config\file.txt
                const result = resolveRelativePath('Users\\testuser\\.config\\app\\settings.json');

                // Should be absolute path
                expect(result).not.toContain('Users\\testuser\\.config\\app\\Users'); // No duplication
                expect(result.endsWith('settings.json')).toBe(true);
            });

            it('handles Windows Pictures directory pattern', () => {
                const result = resolveRelativePath('Users\\testuser\\Pictures\\photo.jpg');
                expect(result).not.toContain('Pictures\\Users'); // No duplication
                expect(result.endsWith('photo.jpg')).toBe(true);
            });

            it('handles drive letter without separator (edge case)', () => {
                const result = resolveRelativePath('C:Users\\test\\file.txt');
                expect(result).toContain('C:');
                expect(result.endsWith('file.txt')).toBe(true);
            });
        });

        describe('Unix absolute paths', () => {
            it('resolves Unix absolute path with leading slash', () => {
                const result = resolveRelativePath('/Users/test/file.txt');
                expect(result).toMatch(/^\/Users/); // Starts with root
                expect(result.endsWith('file.txt')).toBe(true);
            });

            it('resolves Unix absolute path with leading backslash (cross-platform)', () => {
                const result = resolveRelativePath('\\Users\\test\\file.txt');
                expect(result.endsWith('file.txt')).toBe(true);
            });

            it('handles mixed separators in Unix paths', () => {
                const result = resolveRelativePath('/Users/test\\subdir/file.txt');
                expect(result.endsWith('file.txt')).toBe(true);
            });
        });

        describe('relative paths', () => {
            it('resolves simple filename against cwd', () => {
                const result = resolveRelativePath('file.txt');
                expect(result).toContain('file.txt');
                expect(path.isAbsolute(result)).toBe(true);
            });

            it('resolves relative path with dot', () => {
                const result = resolveRelativePath('./file.txt');
                expect(result).toContain('file.txt');
                expect(path.isAbsolute(result)).toBe(true);
            });

            it('resolves relative path with parent directory reference', () => {
                const result = resolveRelativePath('..\\file.txt');
                expect(result).toContain('file.txt');
                expect(path.isAbsolute(result)).toBe(true);
            });

            it('resolves nested relative path', () => {
                const result = resolveRelativePath('subdir/file.txt');
                expect(result).toContain('subdir');
                expect(result.endsWith('file.txt')).toBe(true);
            });

            it('resolves complex relative path with mixed separators', () => {
                const result = resolveRelativePath('..\\../subdir/file.txt');
                expect(result).toContain('subdir');
                expect(result.endsWith('file.txt')).toBe(true);
            });
        });

        describe('edge cases and cross-platform compatibility', () => {
            it('handles path with multiple consecutive separators', () => {
                const result = resolveRelativePath('C:\\\\Users\\\\test\\\\file.txt');
                expect(result).not.toContain('\\\\'); // No double separators
                expect(result.endsWith('file.txt')).toBe(true);
            });

            it('handles path with mixed forward and back slashes', () => {
                const result = resolveRelativePath('C:/Users\\test/subdir/file.txt');
                expect(result.endsWith('file.txt')).toBe(true);
            });

            it('handles very long Windows paths', () => {
                const longPath = 'Users\\testuser\\.openclaw\\workspace\\subdir1\\subdir2\\subdir3\\very-long-filename.xlsx';
                const result = resolveRelativePath(longPath);
                expect(result.endsWith('very-long-filename.xlsx')).toBe(true);
                expect(result).not.toContain('workspace\\subdir1\\Users'); // No duplication
            });

            it('handles path with special characters in filename', () => {
                const result = resolveRelativePath('test file (1) [copy].txt');
                expect(result).toContain('test file');
                expect(result.endsWith('.txt')).toBe(true);
            });

            it('handles path with dots in filename (not directory)', () => {
                const result = resolveRelativePath('folder/.hiddenfile');
                expect(result).toContain('.hiddenfile');
            });

            it('handles path with multiple dots in directory name', () => {
                const result = resolveRelativePath('Users\\testuser\\.openclaw.v1\\workspace\\file.txt');
                expect(result).not.toContain('workspace\\Users'); // No duplication
            });
        });

        describe('real-world OpenClaw scenarios', () => {
            it('handles OpenClaw workspace file on Windows', () => {
                Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
                const workspacePath = 'Users\\username\\.openclaw\\workspace\\document.xlsx';
                const result = resolveRelativePath(workspacePath);

                // Should be absolute without duplication
                expect(result).not.toMatch(/workspace.*workspace/); // No 'workspace' appearing twice
                expect(result.endsWith('document.xlsx')).toBe(true);
            });

            it('handles OpenClaw workspace file on Unix', () => {
                const workspacePath = '/Users/username/.openclaw/workspace/document.pdf';
                const result = resolveRelativePath(workspacePath);

                expect(result).toMatch(/^\/Users/);
                expect(result.endsWith('document.pdf')).toBe(true);
            });

            it('handles file in user Pictures directory on Windows', () => {
                const picturesPath = 'Users\\username\\Pictures\\screenshot.png';
                const result = resolveRelativePath(picturesPath);

                expect(result).not.toMatch(/Pictures.*Pictures/); // No duplication
                expect(result.endsWith('screenshot.png')).toBe(true);
            });

            it('handles CSV file in OpenClaw workspace', () => {
                const csvPath = 'Users\\username\\.openclaw\\workspace\\data.csv';
                const result = resolveRelativePath(csvPath);

                expect(result).not.toContain('workspace\\Users');
                expect(result.endsWith('data.csv')).toBe(true);
            });
        });

        describe('regression tests', () => {
            it('does not duplicate path segments (main bug fix)', () => {
                Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
                // This was the reported issue
                const input = 'Users\\username\\.openclaw\\workspace\\test.xlsx';
                const result = resolveRelativePath(input);

                // The bug caused: C:\...\workspace\Users\...\workspace\test.xlsx
                // Fixed to: C:\Users\...\workspace\test.xlsx
                const matches = result.match(/workspace/g);
                expect(matches?.length).toBeLessThanOrEqual(1); // 'workspace' appears at most once
            });

            it('preserves Unix path behavior (no breaking changes)', () => {
                const unixPath = '/home/user/.openclaw/workspace/file.txt';
                const result = resolveRelativePath(unixPath);

                // Unix paths should still work correctly
                expect(result).toMatch(/^\/(home|Users)/);
                expect(result.endsWith('file.txt')).toBe(true);
            });
        });
    });
});
