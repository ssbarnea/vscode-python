// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import '../extensions';

import { inject, injectable, named } from 'inversify';
import { IExtensionSingleActivationService } from '../../../client/activation/types';
import { IServiceContainer } from '../../ioc/types';
import { IApplicationEnvironment, ICommandManager } from '../application/types';
import { Commands, isTestExecution } from '../constants';
import { IExtensionBuildInstaller, INSIDERS_INSTALLER } from '../installer/types';
import { IDisposable, IDisposableRegistry } from '../types';
import { ExtensionChannels, IExtensionChannelRule, IExtensionChannelService, IInsiderExtensionPrompt } from './types';
import { UIKind } from 'vscode';
import { sleep } from '../utils/async';
import { traceDecoratorError } from '../../logging';

@injectable()
export class InsidersExtensionService implements IExtensionSingleActivationService {
    constructor(
        @inject(IExtensionChannelService) private readonly extensionChannelService: IExtensionChannelService,
        @inject(IInsiderExtensionPrompt) private readonly insidersPrompt: IInsiderExtensionPrompt,
        @inject(IApplicationEnvironment) private readonly appEnvironment: IApplicationEnvironment,
        @inject(ICommandManager) private readonly cmdManager: ICommandManager,
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(IExtensionBuildInstaller)
        @named(INSIDERS_INSTALLER)
        private readonly insidersInstaller: IExtensionBuildInstaller,
        @inject(IDisposableRegistry) public readonly disposables: IDisposable[],
    ) {}

    public async activate() {
        this.registerCommandsAndHandlers();
        await this.initChannel();
    }

    public registerCommandsAndHandlers(): void {
        this.disposables.push(
            this.extensionChannelService.onDidChannelChange((channel) => {
                return this.handleChannel(channel, true);
            }),
        );
        this.disposables.push(
            this.cmdManager.registerCommand(Commands.SwitchOffInsidersChannel, () =>
                this.extensionChannelService.updateChannel('off'),
            ),
        );
        this.disposables.push(
            this.cmdManager.registerCommand(Commands.SwitchToInsidersDaily, () =>
                this.extensionChannelService.updateChannel('daily'),
            ),
        );
        this.disposables.push(
            this.cmdManager.registerCommand(Commands.SwitchToInsidersWeekly, () =>
                this.extensionChannelService.updateChannel('weekly'),
            ),
        );
    }

    public async initChannel() {
        const channel = this.extensionChannelService.getChannel();
        const isDefault = this.extensionChannelService.isChannelUsingDefaultConfiguration;

        const alreadyHandled = await this.handleEdgeCases(isDefault);
        if (!alreadyHandled) {
            this.handleChannel(channel).ignoreErrors();
        }
    }

    // Everything past here is the "channel handler" implementation.

    @traceDecoratorError('Handling channel failed')
    public async handleChannel(installChannel: ExtensionChannels, didChannelChange: boolean = false): Promise<void> {
        const channelRule = this.serviceContainer.get<IExtensionChannelRule>(IExtensionChannelRule, installChannel);
        const shouldInstall = await channelRule.shouldLookForInsidersBuild(didChannelChange);
        if (!shouldInstall) {
            return;
        }
        await this.insidersInstaller.install();
        await this.insidersPrompt.promptToReload();
    }

    /**
     * Choose what to do in miscellaneous situations
     * @returns `true` if install channel is handled in these miscellaneous cases, `false` if install channel needs further handling
     */
    public async handleEdgeCases(isDefault: boolean): Promise<boolean> {
        // When running UI Tests we might want to disable these prompts.
        if (process.env.UITEST_DISABLE_INSIDERS) {
            return true;
        } else if (await this.promptToInstallInsidersIfApplicable(isDefault)) {
            return true;
        } else {
            return false;
        }
    }

    /**
     * Only when using VSC insiders and if they have not been notified before (usually the first session), notify to enroll into the insiders program
     * @returns `true` if prompt is shown, `false` otherwise
     */
    private async promptToInstallInsidersIfApplicable(isDefault: boolean): Promise<boolean> {
        if (this.appEnvironment.channel !== 'insiders') {
            return false;
        }
        if (this.appEnvironment.uiKind === UIKind.Web) {
            // We're running in Codespaces browser-based editor, do not show prompt.
            return false;
        }
        if (this.insidersPrompt.hasUserBeenNotified.value) {
            return false;
        }
        if (!isDefault) {
            return false;
        }

        if (!isTestExecution()) {
            // Wait for 5 mins before showing the prompt.
            await sleep(5 * 60 * 1000);
        }

        await this.insidersPrompt.promptToInstallInsiders();
        return true;
    }
}
