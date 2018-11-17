/**
 * @author Landmaster
 */

const Discord = require('discord.js');
const commandLineArgs = require('command-line-args');
const gameloop = require('node-gameloop');
const Promise = require('bluebird');
const rp = require('request-promise');
const _ = require('underscore');
const wu = require('wu');
const bounds = require('binary-search-bounds');

wu.prototype.length = function () {
	let len=0;
	for (let v of this) ++len;
	return len;
};

const optionDefinitions = [
	{ name: 'token', type: String, defaultOption: true, defaultValue: process.env.QUIPLASH_DISCORD_TOKEN }
];
const options = commandLineArgs(optionDefinitions);

const client = new Discord.Client();

/**
 *
 * @template T
 * @constructor
 * @augments Promise<T>
 */
function ManualResolvePromise() {
	Promise.call(this, (res, rej) => {
		this.resolve = res;
		this.reject = rej;
	});
}
ManualResolvePromise.prototype = Object.create(Promise.prototype);

/**
 * @param {string} channelId
 * @param {string} initiator
 * @param {string} [promptURL]
 * @constructor
 */
function GameInstance(channelId, initiator, promptURL) {
	this.channelId = channelId;
	this.initiator = initiator;
	/**
	 *
	 * @type {Set<string>}
	 */
	this.players = new Set();
	
	/**
	 *
	 * @type {Map<string, number>}
	 */
	this.playerScores = new Map();
	
	this.elapsedTime = 0;
	
	/**
	 *
	 * @type {Set<Function>}
	 */
	this.gameloopHandlers = new Set();
	this.gameloopHandlers.add(() => {++this.elapsedTime;});
	
	this.gameloop = gameloop.setGameLoop(delta => {
		this.gameloopHandlers.forEach(fn => fn(delta));
	}, 1000);
	
	this.round = 0;
	this.isVoting = false;
	
	let channel = client.channels.get(this.channelId);
	
	/**
	 *
	 * @type {Map<string, ManualResolvePromise<string>>}
	 */
	this.responses = new Map();
	/**
	 *
	 * @type {Map<string, ManualResolvePromise<string>>}
	 */
	this.responses0 = new Map();
	
	/**
	 *
	 * @type {?Map<string, boolean>}
	 * @property {string[]} playersInContest
	 */
	this.votedFor1 = null;
	
	/**
	 *
	 * @type {Map<string, number>[]}
	 * @property {string[]} playersInContest
	 */
	this.finalVoteNums = null;
	
	/**
	 *
	 * @type {Promise<Array<string>>}
	 */
	this.prompts = promptURL ? rp(promptURL)
		.then(content => {
			let arr = content.split('\n').filter(str => !!str);
			if (arr.length < this.maxPlayers()*2) {
				throw new Error('The amount of prompts in the pack is '+arr.length+', but should be at least '+this.maxPlayers()*2);
			}
			return arr;
		}).catch(err => {
			channel.send('---------------\nThere was an **ERROR** retrieving the prompt pack at '+promptURL+':');
			channel.send(err.toString());
			channel.send('Using default prompt pack\n---------------');
			
			return GameInstance.DEFAULT_PROMPTS;
		}) : Promise.resolve(GameInstance.DEFAULT_PROMPTS);
	
	this.curPromptsPromise = this.prompts.then(prompts => _.sample(prompts, this.maxPlayers()*2))
}
GameInstance.prototype.getAllPlayersMention = function() {
	let res = '';
	for (let playerID of this.players) {
		res += '<@'+playerID+'>\n';
	}
	return res;
};
GameInstance.prototype.addPlayer = function(playerID) {
	let channel = client.channels.get(this.channelId);
	let maxPlayers = this.maxPlayers();
	if (this.round >= 1) {
		// nothing
	} if (playerToGameInstance.has(playerID)) {
		channel.send('<@'+playerID+'> has already joined this or some other Quiplash game');
	} else if (this.players.size <= maxPlayers) {
		this.players.add(playerID);
		playerToGameInstance.set(playerID, this);
		channel.send('<@'+playerID+'> joined');
	} else {
		channel.send('<@'+playerID+'> could not join, because there are already '+maxPlayers+' players in the game');
	}
};
GameInstance.prototype.removePlayer = function(playerID, verbose) {
	let channel = client.channels.get(this.channelId);
	if (!this.players.has(playerID)) {
		if (verbose) channel.send('<@'+playerID+'> already left or is not in this game');
	} else {
		this.players.delete(playerID);
		if (this.responses.has(playerID)) {
			let respProm = this.responses.get(playerID);
			if (this.players.size >= 3) {
				respProm.resolve(GameInstance.SAFETY_QUIP);
			} else {
				respProm.reject(new Error(''));
			}
		}
		if (this.responses0.has(playerID) && this.players.size >= 3) {
			let respProm0 = this.responses0.get(playerID);
			if (this.players.size >= 3) {
				respProm0.resolve(GameInstance.SAFETY_QUIP);
			} else {
				respProm0.reject(new Error(''));
			}
		}
		this.playerScores.delete(playerID);
		playerToGameInstance.delete(playerID);
		if (verbose) {
			channel.send('<@'+playerID+'> left');
			if (this.round >= 1 && this.players.size < 3) {
				channel.send('Not enough players anymore; stopping game early');
				this.stop(false);
			}
		}
	}
};
GameInstance.prototype.create = function() {
	channelToGameInstance.set(this.channelId, this);
	let channel = client.channels.get(this.channelId);
	channel.send('<@'+this.initiator+'> created a Quiplash game.\n' +
		'Text "/ql join" on this channel to join this game, and "/ql leave" to leave.\n' +
		'A maximum of '+this.maxPlayers()+' players can join.\n' +
		'<@'+this.initiator+'> can text "/ql start" to start once everyone is ready, or let it start automatically after '+this.autoStartTime()+' seconds.\n' +
		'Both this person and anyone capable of deleting messages in this channel can halt this game at any time with "/ql stop".\n'+
		'Anyone in this channel can vote for the best quip, even if not in the game!');
	let autoStartTime = this.autoStartTime();
	let self = this;
	this.gameloopHandlers.add(function handle() {
		if (self.round >= 1) {
			self.gameloopHandlers.delete(handle);
			return;
		}
		switch (autoStartTime - self.elapsedTime) {
			case 15:
			case 30:
			case 60:
				channel.send(self.getAllPlayersMention()+''+(autoStartTime - self.elapsedTime)+' seconds left until Quiplash starts');
		}
		if (self.elapsedTime === autoStartTime) {
			self.start(false);
		}
	});
};
GameInstance.prototype.maxPlayers = function() { return 8; };
GameInstance.prototype.autoStartTime = function() { return 90; };
GameInstance.prototype.mainPromptRespTime = function() { return 110; };
GameInstance.prototype.start = function (isInitiated) {
	let channel = client.channels.get(this.channelId);
	if (this.players.size < 3) {
		if (!isInitiated) {
			channel.send('Quiplash does not have enough players! At least 3 are needed, stopping');
			this.stop(false);
		} else {
			channel.send('At least 3 players are needed to start.');
		}
	} else if (this.round === 0) {
		channel.send(this.getAllPlayersMention()+'Quiplash has started! <@' + client.user.id + '> will send you prompts directly to answer.');
		this.executeRound();
	}
};
GameInstance.prototype.executeRound = function () {
	++this.round;
	
	this.isVoting = false;
	this.responses.clear(); this.responses0.clear();
	
	let channel = client.channels.get(this.channelId);
	
	if (this.round <= 2) {
		let congaLine = _.shuffle(Array.from(this.players));
		
		if (this.round === 1) {
			channel.send('__**ROUND ONE**__\nPoints awarded by the percentage of players that vote for your response.');
		} else if (this.round === 2) {
			channel.send('__**ROUND TWO**__\n*All point values 2×!*');
		}
		
		channel.send(this.getAllPlayersMention()+'**Answer the prompts sent by <@'+client.user.id+'> by direct message now. You have '+this.mainPromptRespTime()+' seconds.**');
		
		this.curPromptsPromise.then(curPrompts => {
			for (let i = 0; i < congaLine.length; ++i) {
				let member = channel.members.get(congaLine[i]);
				
				let resolvePromise = new ManualResolvePromise();
				this.responses.set(congaLine[i], resolvePromise);
				
				let resolvePromise0 = new ManualResolvePromise();
				this.responses0.set(congaLine[i], resolvePromise0);
				
				if (!member.user.bot && this.players.has(member.id)) {
					//
					// FIRST QUESTION
					//
					member.send('__Answer the prompt:__ '+curPrompts[(this.round-1) * this.maxPlayers() + i]);
				} else {
					this.responses.get(congaLine[i]).resolve(GameInstance.SAFETY_QUIP);
				}
				
				// Once the 1st question has a response, the 2nd question starts.
				resolvePromise.then(() => {
					if (!member.user.bot && this.players.has(member.id)) {
						//
						// SECOND QUESTION
						//
						member.send('__Answer the prompt:__ '+curPrompts[(this.round-1) * this.maxPlayers() + (i + 1) % congaLine.length]);
					} else {
						this.responses0.get(congaLine[i]).resolve(GameInstance.SAFETY_QUIP);
					}
				});
			}
			
			Promise.all(this.responses.values()).then(() => {
				return Promise.all(this.responses0.values()).then(() => {
					this.doVoting(curPrompts, congaLine);
				});
			}).catch(console.error);
			
			let mainPromptRespTime = this.mainPromptRespTime();
			let startTime = this.elapsedTime;
			let self = this;
			this.gameloopHandlers.add(function handle() {
				if (self.isVoting) {
					self.gameloopHandlers.delete(handle);
					return;
				}
				switch(mainPromptRespTime - (self.elapsedTime - startTime)) {
					case 60:
					case 30:
					case 15:
						let warning = (mainPromptRespTime - (self.elapsedTime - startTime))+' seconds left to type in both responses'
						channel.send(self.getAllPlayersMention()+warning);
						for (let playerID of self.players) {
							let member = channel.members.get(playerID);
							if (!member.user.bot) {
								member.send(warning);
							}
						}
				}
				if (self.elapsedTime - startTime === mainPromptRespTime) {
					for (let response in self.responses.values()) {
						response.resolve(GameInstance.SAFETY_QUIP);
					}
					for (let response0 in self.responses0.values()) {
						response0.resolve(GameInstance.SAFETY_QUIP);
					}
				}
			});
		});
	} else if (this.round === 3) {
		channel.send('__**THE LAST LASH!**__\nEveryone gets the same prompt!');
		
		let promptStr = '__FINAL PROMPT:__ Come up with a full name for the acronym:\n'
			+'**'+genRandLetterWeighted(Math.random)+genRandLetterWeighted(Math.random)+genRandLetterWeighted(Math.random)+'**';
		channel.send(promptStr);
		
		let frozenPlayerList = Array.from(this.players);
		
		for (let playerID of frozenPlayerList) {
			let player = channel.members.get(playerID);
			if (!player.user.bot) player.send(promptStr);
		}
		
		channel.send(this.getAllPlayersMention()+'**Answer the prompts sent by <@'+client.user.id+'> by direct message now. You have '+this.finalPromptRespTime()+' seconds.**');
		for (let playerID of frozenPlayerList) {
			let player = channel.members.get(playerID);
			if (!player.user.bot) player.send('**Answer the prompt here!**');
		}
		
		for (let playerID of frozenPlayerList) {
			let resolvePromise = new ManualResolvePromise();
			this.responses.set(playerID, resolvePromise);
			if (channel.members.get(playerID).user.bot) {
				resolvePromise.resolve(GameInstance.SAFETY_QUIP);
			}
		}
		
		let finalPromptRespTime = this.finalPromptRespTime();
		let startTime = this.elapsedTime;
		let self = this;
		this.gameloopHandlers.add(function handle() {
			if (self.isVoting) {
				self.gameloopHandlers.delete(handle);
				return;
			}
			switch(finalPromptRespTime - (self.elapsedTime - startTime)) {
				case 60:
				case 30:
				case 15:
					let warning = (finalPromptRespTime - (self.elapsedTime - startTime))+' seconds left to type in a response';
					channel.send(self.getAllPlayersMention()+warning);
					for (let playerID of self.players) {
						let member = channel.members.get(playerID);
						if (!member.user.bot) {
							member.send(warning);
						}
					}
			}
			if (self.elapsedTime - startTime === finalPromptRespTime) {
				for (let response in self.responses.values()) {
					response.resolve(GameInstance.SAFETY_QUIP);
				}
			}
		});
		
		Promise.all(this.responses.values()).then(() => {
			this.doFinalVoting(frozenPlayerList, promptStr);
		}).catch(console.error);
	}
};
GameInstance.prototype.finalPromptRespTime = function () {
	return 80;
};
GameInstance.prototype.doFinalVoting = function (frozenPlayerList, finalPrompt) {
	this.isVoting = true;
	
	let numVotes = Math.min(3, frozenPlayerList.length - 2);
	
	let channel = client.channels.get(this.channelId);
	
	let voteNuncString = '**Time to vote on the best quip!**\n' +
		'The prompt’s responses are numbered 1 to '+this.responses.size+'.\n' +
		'Send the numbers of your **'+numVotes+'** favorite responses (**including** your own, as long as you do **not** pick yourself as the 1st choice), in **order of preference**, **directly** to <@'+client.user.id+'> to vote!\n' +
		'The audience can join in too!';
	
	channel.send('@here\n'+voteNuncString);
	channel.send(finalPrompt);
	for (let guildMember of channel.members.values()) {
		if (!guildMember.user.bot) {
			guildMember.send(voteNuncString);
			guildMember.send(finalPrompt);
		}
	}
	
	
	let finalVoteDelayTime = this.finalVoteDelayTime();
	let finalVoteTime = this.finalVoteTime();
	
	let startTime = null;
	let self = this;
	this.gameloopHandlers.add(function handle() {
		if (startTime === null) {
			startTime = self.elapsedTime;
		}
		
		if (self.elapsedTime - startTime === finalVoteDelayTime) {
			self.finalVoteNums = new Array(numVotes);
			for (let i=0; i<self.finalVoteNums.length; ++i) {
				self.finalVoteNums[i] = new Map();
			}
			self.finalVoteNums.playersInContest = frozenPlayerList;
			
			let finalRespsListStr = '';
			for (let idx=0; idx<frozenPlayerList.length; ++idx) {
				finalRespsListStr += '__Answer '+(idx+1)+':__ '+self.responses.get(frozenPlayerList[idx]).value()+'\n';
			}
			
			channel.send(finalRespsListStr);
			channel.send('Vote for your **'+numVotes+'** favorites directly to <@'+client.user.id+'>!');
			
			for (let guildMember of channel.members.values()) {
				if (!guildMember.user.bot) {
					guildMember.send(finalRespsListStr);
					guildMember.send('Vote for your **'+numVotes+'** favorites here! You have '+finalVoteTime+' seconds to vote!');
					let curIdx = frozenPlayerList.indexOf(guildMember.user.id);
					if (curIdx >= 0) {
						guildMember.send('(__Answer '+(curIdx+1)+'__ is your own. You can still vote for it, as long as it is not your 1st pick.)');
					}
				}
			}
		}
		
		if (finalVoteDelayTime < self.elapsedTime - startTime && self.elapsedTime - startTime < finalVoteDelayTime + finalVoteTime) {
			switch (finalVoteDelayTime + finalVoteTime - (self.elapsedTime - startTime)) {
				case 10:
				case 20:
				case 30:
					let notifStr = `${finalVoteDelayTime + finalVoteTime - (self.elapsedTime - startTime)} seconds left to vote!`;
					channel.send('@here\n'+notifStr);
					for (let guildMember of channel.members.values()) {
						if (!guildMember.user.bot) {
							guildMember.send(notifStr);
						}
					}
			}
		}
		
		if (self.elapsedTime - startTime === finalVoteDelayTime + finalVoteTime) {
			let playerListEnum = Array.from(wu(frozenPlayerList).enumerate());
			let finalVoteCount = new Array(frozenPlayerList.length);
			for (let i=0; i<finalVoteCount.length; ++i) {
				finalVoteCount[i] = new Array(numVotes);
				finalVoteCount[i].fill(0);
			}
			for (let i=0; i<self.finalVoteNums.length; ++i) {
				for (let val of self.finalVoteNums[i].values()) {
					++finalVoteCount[val][i];
				}
			}
			
			playerListEnum.sort(([playerID,idx], [playerID0,idx0]) => {
				for (let i=0; i<self.finalVoteNums.length; ++i) {
					if (finalVoteCount[idx][i] !== finalVoteCount[idx0][i]) {
						return finalVoteCount[idx][i] - finalVoteCount[idx0][i];
					}
				}
				return 0;
			});
			
			let finalScores = new Array(frozenPlayerList.length);
			
			let prevCount = new Array(numVotes);
			prevCount.fill(0);
			let curScore = 0;
			for (let [playerID,idx] of playerListEnum) {
				if (!_.isEqual(prevCount, finalVoteCount[idx])) {
					curScore += 500;
				}
				finalScores[idx] = curScore;
				prevCount = finalVoteCount[idx];
			}
			
			for (let i=0; i<finalScores.length; ++i) {
				if (finalScores[i]) {
					//console.log(finalScores[i]);
					finalScores[i] += (frozenPlayerList.length*500 - finalScores[playerListEnum[playerListEnum.length-1][1]]);
				}
				
				self.playerScores.set(frozenPlayerList[i], (self.playerScores.get(frozenPlayerList[i])||0) + finalScores[i] );
			}
			
			let finalScoreIncrsString = '';
			for (let i=0; i<frozenPlayerList.length; ++i) {
				finalScoreIncrsString += `__Answer ${i+1}__ belonged to <@${frozenPlayerList[i]}>, who gets ${finalScores[i]} points (${finalVoteCount[i][0] || 0} gold, ${finalVoteCount[i][1] || 0} silver, ${finalVoteCount[i][2] || 0} bronze)\n`;
			}
			
			channel.send('@here\n'+finalScoreIncrsString);
			for (let guildMember of channel.members.values()) {
				if (!guildMember.user.bot) {
					guildMember.send(finalScoreIncrsString);
				}
			}
			
			self.recap(true);
			self.stop(false);
		}
	});
};
GameInstance.prototype.finalVoteDelayTime = function() {
	return 5;
};
GameInstance.prototype.finalVoteTime = function() {
	return 40;
};
GameInstance.prototype.recap = function (final) {
	let recapString = '';
	recapString += final ? '__**Final Scores:**__\n' : '__**Scoreboard:**__\n';
	let playersByScore = Array.from(this.players).sort((p1,p2) => (this.playerScores.get(p2)||0) - (this.playerScores.get(p1)||0));
	for (let playerID of playersByScore) {
		recapString += '<@'+playerID+'>: '+(this.playerScores.get(playerID)||0)+'\n';
	}
	
	let channel = client.channels.get(this.channelId);
	channel.send('@here\n'+recapString);
	
	for (let guildMember of channel.members.values()) {
		if (!guildMember.user.bot) {
			guildMember.send('Check out '+channel+' for the score recap!');
		}
	}
	
	if (final) {
		let congratsString = '__**Winner(s):**__\n';
		
		let maxScore = null;
		for (let playerID of playersByScore) {
			if (maxScore === null) {
				maxScore = (this.playerScores.get(playerID)||0);
			}
			if ((this.playerScores.get(playerID)||0) === maxScore) {
				congratsString += '<@'+playerID+'>\n';
			}
		}
		
		congratsString += '**Congratulations!**';
		
		channel.send(congratsString);
	}
};
GameInstance.prototype.doVoting = function (curPrompts, congaLine) {
	this.isVoting = true;
	
	
	let channel = client.channels.get(this.channelId);
	
	let voteNuncString = '**Time to vote on the best quip!**\n' +
		'2 choices will be posted for each prompt.\n' +
		'Send "1" or "2" **directly** to <@'+client.user.id+'> to pick which numbered quip is the funniest!\n' +
		'The audience can join in too!';
	
	channel.send('@here\n'+voteNuncString);
	for (let guildMember of channel.members.values()) {
		if (!guildMember.user.bot) {
			guildMember.send(voteNuncString);
		}
	}
	
	let voteDelayTime = this.voteDelayTime();
	let voteTime = this.voteTime();
	let MODULUS = voteTime + 2*voteDelayTime;
	
	let startTime = null;
	let self = this;
	this.gameloopHandlers.add(function handle() {
		if (startTime === null) {
			startTime = self.elapsedTime;
		}
		
		let timeOffset = self.elapsedTime - startTime;
		
		let promptIdx = Math.floor(timeOffset / MODULUS);
		if (promptIdx >= congaLine.length) {
			self.gameloopHandlers.delete(handle);
			self.recap(false);
			
			let endTime = self.elapsedTime;
			let endVoteDelayTime = self.endVoteDelayTime();
			
			self.gameloopHandlers.add(function handle2() {
				if (self.elapsedTime - endTime === endVoteDelayTime) {
					self.executeRound();
				}
			});
			return;
		}
		
		let playerID = congaLine[promptIdx], playerID0 = congaLine[ (promptIdx+congaLine.length-1) % congaLine.length ];
		
		if (timeOffset % MODULUS === 0) {
			let promptStr = '__**Prompt:**__ '+curPrompts[(self.round - 1) * self.maxPlayers() + promptIdx];
			channel.send(promptStr);
			for (let guildMember of channel.members.values()) {
				if (!guildMember.user.bot) {
					guildMember.send(promptStr);
				}
			}
		}
		if (timeOffset % MODULUS === voteDelayTime) {
			//console.log(channel.members.get(playerID).displayName, channel.members.get(playerID0).displayName);
			
			let respString = '__Answer 1:__ '+self.responses.get(playerID).value();
			let respString0 = '__Answer 2:__ '+self.responses0.get(playerID0).value();
			channel.send(respString+'\n'+respString0+'\nSend "1" or "2" **directly** to <@'+client.user.id+'> now!');
			for (let guildMember of channel.members.values()) {
				if (!guildMember.user.bot) {
					guildMember.send(respString+'\n'+respString0);
					if ([playerID,playerID0].indexOf(guildMember.user.id) < 0) {
						guildMember.send('**Vote "1" or "2" for your favorite __here!__ You have '+voteTime+' seconds.**');
					} else {
						guildMember.send('(One of these responses is yours, so no voting for now.)');
					}
				}
			}
			
			self.votedFor1 = new Map();
			self.votedFor1.playersInContest = [playerID, playerID0];
		}
		
		if (timeOffset % MODULUS === voteDelayTime + voteTime) {
			let mainVotesFor1Iter = wu(self.votedFor1)
				.filter(kv => self.players.has(kv[0]) && kv[1]);
			let mainVotesFor1 = wu(self.votedFor1)
				.filter(kv => self.players.has(kv[0]) && kv[1]).length();
			let mainVotesFor2Iter = wu(self.votedFor1)
				.filter(kv => self.players.has(kv[0]) && !kv[1]);
			let mainVotesFor2 = wu(self.votedFor1)
				.filter(kv => self.players.has(kv[0]) && !kv[1]).length();
			let allVotesFor1 = wu(self.votedFor1)
				.filter(kv => kv[1])
				.length();
			let allVotesFor2 = self.votedFor1.size - allVotesFor1;
			
			let respString = '__Answer 1__ was provided by <@'+playerID+'>.\n__Answer 2__ was provided by <@'+playerID0+'>.\n';
			if (allVotesFor1+allVotesFor2 === 0) {
				respString += '**NO VOTES FOR EITHER ANSWER THIS TIME!**\nNo points awarded.';
			} else {
				let pc1 = Math.round(100 * allVotesFor1 / (allVotesFor1+allVotesFor2)),
					pc2 = Math.round(100 * allVotesFor2 / (allVotesFor1+allVotesFor2));
				
				respString += 'The player(s) that voted for __Answer 1__:\n';
				for (let kv of mainVotesFor1Iter) {
					respString += channel.members.get(kv[0]).displayName+'\n';
				}
				if (mainVotesFor1 === 0) respString += '*No player*\n';
				
				respString += 'The player(s) that voted for __Answer 2__:\n';
				for (let kv of mainVotesFor2Iter) {
					respString += channel.members.get(kv[0]).displayName+'\n';
				}
				if (mainVotesFor2 === 0) respString += '*No player*\n';
				
				respString += (allVotesFor1 - mainVotesFor1) + ' audience members voted for __Answer 1__\n';
				respString += (allVotesFor2 - mainVotesFor2) + ' audience members voted for __Answer 2__\n';
				
				respString += allVotesFor1+' people ('+pc1+'%) in total voted for __Answer 1__\n'+allVotesFor2+' people ('+pc2+'%) in total voted for __Answer 2__\n';
				
				if (allVotesFor1 === allVotesFor2) {
					self.playerScores.set(playerID, (self.playerScores.get(playerID)||0) + 500*self.getRoundMultipler());
					self.playerScores.set(playerID0, (self.playerScores.get(playerID0)||0) + 500*self.getRoundMultipler());
					respString += '**TIE!**\nBoth <@'+playerID+'> and <@'+playerID0+'> get '+500*self.getRoundMultipler()+' points!';
				} else if (mainVotesFor1 === 0 && allVotesFor1 < allVotesFor2) {
					self.playerScores.set(playerID0, (self.playerScores.get(playerID0)||0) + (10*pc2 + 250)*self.getRoundMultipler());
					respString += '**QUIPLASH!**\n<@'+playerID0+'> gets '+10*pc2*self.getRoundMultipler()+'+'+250*self.getRoundMultipler()+' points!';
				} else if (mainVotesFor2 === 0 && allVotesFor1 > allVotesFor2) {
					self.playerScores.set(playerID, (self.playerScores.get(playerID)||0) + (10*pc1 + 250)*self.getRoundMultipler());
					respString += '**QUIPLASH!**\n<@'+playerID+'> gets '+10*pc1*self.getRoundMultipler()+'+'+250*self.getRoundMultipler()+' points!';
				} else if (allVotesFor1 < allVotesFor2) {
					self.playerScores.set(playerID, (self.playerScores.get(playerID)||0) + 10*pc1*self.getRoundMultipler());
					self.playerScores.set(playerID0, (self.playerScores.get(playerID0)||0) + (10*pc2+100)*self.getRoundMultipler());
					respString += '**<@'+playerID0+'>wins!**\n<@'+playerID0+'> gets '+10*pc2*self.getRoundMultipler()+'+'+100*self.getRoundMultipler()+' points\n'
					+'<@'+playerID+'> gets '+10*pc1*self.getRoundMultipler()+' points';
				} else {
					self.playerScores.set(playerID, (self.playerScores.get(playerID)||0) + (10*pc1+100)*self.getRoundMultipler());
					self.playerScores.set(playerID0, (self.playerScores.get(playerID0)||0) + 10*pc2*self.getRoundMultipler());
					respString += '**<@'+playerID+'>wins!**\n<@'+playerID+'> gets '+10*pc1*self.getRoundMultipler()+'+'+100*self.getRoundMultipler()+' points\n'
						+'<@'+playerID0+'> gets '+10*pc2*self.getRoundMultipler()+' points';
				}
			}
			
			channel.send(respString);
			for (let guildMember of channel.members.values()) {
				if (!guildMember.user.bot) {
					guildMember.send(respString);
				}
			}
			
			self.votedFor1 = null;
		}
	});
};
GameInstance.prototype.getRoundMultipler = function() {
	return this.round;
};
GameInstance.prototype.voteDelayTime = function() {return 4;};
GameInstance.prototype.voteTime = function() {return 18;};
GameInstance.prototype.endVoteDelayTime = function() {return 7;};
Object.defineProperty(GameInstance, 'SAFETY_QUIP', {value: ''});
/**
 *
 * @param {string} playerID
 * @param {string} resp
 */
GameInstance.prototype.registerResponse = function(playerID, resp) {
	//console.log('ID: '+playerID+'; response: '+resp);
	let mainChannel = client.channels.get(this.channelId);
	let member = mainChannel.members.get(playerID);
	
	if (this.responses.has(playerID)) {
		let prom = this.responses.get(playerID);
		if (!prom.isFulfilled()) {
			prom.resolve(resp);
			if (this.round === 3) {
				member.send('Thanks for replying!');
			}
		} else if (this.responses0.has(playerID)) {
			let prom0 = this.responses0.get(playerID);
			if (!prom0.isFulfilled()) {
				prom0.resolve(resp);
				member.send('Thanks for replying!');
			}
		}
	}
};
GameInstance.prototype.registerVote = function(playerID, vote) {
	let voteNum = parseInt(vote, 10);
	if (this.isVoting) {
		let mainChannel = client.channels.get(this.channelId);
		let member = mainChannel.members.get(playerID);
		
		if (this.votedFor1 !== null
			&& this.votedFor1.playersInContest.indexOf(playerID) < 0
			&& !this.votedFor1.has(playerID)) {
			switch (voteNum) {
				case 1:
					this.votedFor1.set(playerID, true);
					break;
				case 2:
					this.votedFor1.set(playerID, false);
					break;
				default:
					member.send('Invalid vote "' + vote + '"');
					return;
			}
			
			member.send('Thanks for voting!');
		} else if (this.finalVoteNums !== null) {
			if (voteNum >= 1 && voteNum <= this.finalVoteNums.playersInContest.length) {
				let curIdx = this.finalVoteNums.playersInContest.indexOf(playerID);
				let i=0;
				let prevVotes = new Set();
				for ( ; i<this.finalVoteNums.length; ++i) {
					if (!this.finalVoteNums[i].has(playerID)) {
						if (curIdx === voteNum-1 && i === 0) {
							member.send('You cannot vote for yourself as the 1st choice!');
							return;
						}
						if (prevVotes.has(voteNum-1)) {
							member.send('You already voted for this!');
							return;
						}
						
						this.finalVoteNums[i].set(playerID, voteNum-1);
						break;
					}
					prevVotes.add(this.finalVoteNums[i].get(playerID));
				}
				if (i === 0) {
					member.send('1st choice received');
				}
				if (i === 1) {
					member.send('2nd choice received');
				}
				if (i === 2) {
					member.send('3rd choice received');
				}
				if (i === this.finalVoteNums.length-1) {
					member.send('Thanks for voting!');
				}
			} else {
				member.send('Invalid vote "' + vote + '"');
			}
		}
	}
};
/**
 *
 * @param {boolean} isInitiated
 */
GameInstance.prototype.stop = function(isInitiated) {
	channelToGameInstance.delete(this.channelId);
	gameloop.clearGameLoop(this.gameloop);
	this.gameloopHandlers.clear();
	
	for (let playerID of this.players) {
		this.removePlayer(playerID, false);
	}
	
	let channel = client.channels.get(this.channelId);
	if (isInitiated) {
		channel.send('The Quiplash game was stopped.');
	}
};

/**
 *
 * @type {Map<string, GameInstance>}
 */
const channelToGameInstance = new Map();

/**
 *
 * @type {Map<string, GameInstance>}
 */
const playerToGameInstance = new Map();

client.on('message', msg => {
	if (msg.content.startsWith('/ql') && !(msg.channel instanceof Discord.DMChannel)) {
		let remContent = msg.content.substring(4);
		let brokenRemContent = remContent.split(/\s+/).filter(str => !!str);
		//console.log(brokenRemContent);
		if (brokenRemContent.length === 0) {
			brokenRemContent = ['help'];
		}
		switch (brokenRemContent[0]) {
			case 'create':
				if (!channelToGameInstance.has(msg.channel.id)) {
					let GI = new GameInstance(msg.channel.id, msg.author.id, brokenRemContent[1]);
					GI.create();
				} else {
					msg.channel.send('Quiplash game already created or in progress');
				}
				break;
			case 'start':
				if (channelToGameInstance.has(msg.channel.id)) {
					let GI = channelToGameInstance.get(msg.channel.id);
					if (msg.author.id === GI.initiator || msg.channel.permissionsFor(msg.channel.members.get(msg.author.id)).has(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
						GI.start(true);
					} else {
						msg.channel.send('Quiplash game can only be started by <@'+GI.initiator+'> or someone who can delete messages in this channel.');
					}
				} else {
					msg.channel.send('Quiplash game not active');
				}
				break;
			case 'stop':
				if (channelToGameInstance.has(msg.channel.id)) {
					let GI = channelToGameInstance.get(msg.channel.id);
					if (msg.author.id === GI.initiator || msg.channel.permissionsFor(msg.channel.members.get(msg.author.id)).has(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
						GI.stop(true);
					} else {
						msg.channel.send('Quiplash game can only be stopped by <@'+GI.initiator+'> or someone who can delete messages in this channel.');
					}
				} else {
					msg.channel.send('Quiplash game not active');
				}
				break;
			case 'join':
				if (channelToGameInstance.has(msg.channel.id)) {
					let GI = channelToGameInstance.get(msg.channel.id);
					GI.addPlayer(msg.author.id);
				} else {
					msg.channel.send('Quiplash game not active');
				}
				break;
			case 'leave':
				if (channelToGameInstance.has(msg.channel.id)) {
					let GI = channelToGameInstance.get(msg.channel.id);
					GI.removePlayer(msg.author.id, true);
				} else {
					msg.channel.send('Quiplash game not active');
				}
				break;
			case 'listPlayers':
				if (channelToGameInstance.has(msg.channel.id)) {
					let GI = channelToGameInstance.get(msg.channel.id);
					let respString = 'Players list:\n';
					for (let playerID of GI.players) {
						respString += msg.channel.members.get(playerID).displayName + '\n';
					}
					msg.channel.send(respString);
				} else {
					msg.channel.send('Quiplash game not active');
				}
				break;
			case 'help':
				msg.channel.send('__HELP__\n' +
					'\u200B/ql create [promptURL] – Create a Quiplash game on this channel. If [promptURL] is specified, use the custom list of prompts (a text file, one line per prompt) at that URL.\n' +
					'\u200B/ql start – Start the Quiplash game created on this channel (if there is any)\n' +
					'\u200B/ql stop — Stop the Quiplash game on this channel\n' +
					'\u200B/ql join — Join a Quiplash game that has been created but not started on this channel\n' +
					'\u200B/ql leave — Leave the Quiplash game on this channel\n' +
					'\u200B/ql listPlayers — Display a list of current players\n' +
					'\u200B/ql help — Show this help');
				break;
			default:
				//msg.channel.send('Invalid command "'+msg+'"');
		}
	} else if (msg.channel instanceof Discord.DMChannel) {
		if (msg.author.id !== client.user.id && playerToGameInstance.has(msg.author.id)) {
			let GI = playerToGameInstance.get(msg.author.id);
			if (!GI.isVoting) {
				GI.registerResponse(msg.author.id, msg.content);
			} else {
				GI.registerVote(msg.author.id, msg.content);
			}
		}
	}
});
client.on('error', console.error);

client.login(options.token).then(token => {
	console.log('Logged in with token '+token)
}).catch(err => {
	console.error(err);
});

let LETTER_FREQ_TABLE = [8.167,
	1.492,
	2.782,
	4.253,
	12.702,
	2.228,
	2.015,
	6.094,
	6.966,
	0.153,
	0.772,
	4.025,
	2.406,
	6.749,
	7.507,
	1.929,
	0.095,
	5.987,
	6.327,
	9.056,
	2.758,
	0.978,
	2.360,
	0.150,
	1.974,
	0.074,];

LETTER_FREQ_TABLE = Array.from(wu(LETTER_FREQ_TABLE).reductions((x,y)=>x+y));
let LETTER_FREQ_TABLE_SUM = LETTER_FREQ_TABLE[LETTER_FREQ_TABLE.length-1];
function genRandLetterWeighted(randFunc) {
	let randIdx = randFunc() * LETTER_FREQ_TABLE_SUM;
	return String.fromCharCode('A'.charCodeAt(0) + bounds.gt(LETTER_FREQ_TABLE, randIdx));
}


/**
 *
 * DEFAULT PROMPTS
 *
 */
Object.defineProperty(GameInstance, 'DEFAULT_PROMPTS', {
	value: ["A weird thing for the letters in your alphabet soup to suddenly spell out",
		"A great prank to play on a pizza delivery guy",
		"The most surprising thing you could find in the glove box of a rental car",
		"Four-leaf clovers are lucky. But if you find a five-leaf clover...",
		"The only job you would do for free",
		"The most German-sounding word you can invent",
		"The worst name for a country music singer",
		"It would be really weird to have a bobblehead doll of __          __",
		"If you can\u2019t say anything nice...",
		"The title of Bob Saget\u2019s biopic",
		"The perfect time to wear stilts",
		"Little-known fact: In a lifetime, the average person will __          __ over 1,000 times while sleeping",
		"A rejected name for tater tots",
		"On the seventh day, God rested. On the eighth day, he __          __",
		"A weird reason to have your car recalled",
		"You should always wear a helmet when __          __",
		"Few remember Michelangelo\u2019s *Mona Lisa 2* which was a painting of __          __",
		"Something a kangaroo might search for on Google",
		"A bad substitute for a surfboard",
		"Where would you live if you were two inches tall?",
		"What to do when a really tall person sits in front of you at the movie theater",
		"An entry in teenage Tarzan\u2019s diary: \u201cToday, I __          __\u201d",
		"The absolute best place to hide your house key",
		"A strange place to go to while wearing a ski mask",
		"What those giant Easter Island heads are thinking",
		"So, how do you like it?",
		"What ruined Hannibal \u201cThe Cannibal\u201d Lecter\u2019s credit score?",
		"What the lamest Transformer would morph into",
		"You would gladly give money to someone on the street if they asked \u201cCan you spare some change so I can __          __?\u201d",
		"SPOILER ALERT: The big plot twist in *The Sisterhood of the Traveling Pants 7* is that the pants __          __",
		"You know you\u2019re a spoiled brat when your tree house has a __          __",
		"What King Kong is most self-conscious about",
		"The only reason to ever play a banjo",
		"The big conspiracy that nobody even suspects is __          __",
		"How Jonah passed the time stuck inside a giant fish",
		"Something that the Keebler Elves chant during a strike",
		"The title of the most popular TV show in North Korea, probably",
		"A quick way to annoy Pat Sajak while playing *Wheel of Fortune*",
		"The title of a National Public Radio show that would put you to sleep the quickest",
		"Where the missing sock in the dryer ends up going",
		"The worst part about being seven feet tall",
		"A really weird protest sign would be \u201cEnd __          __ Now!\u201d",
		"How you can tell your new, all-vegetable diet is working",
		"If Cap\u2019n Crunch ever gets court-martialed, it\u2019ll probably be because he...",
		"Where in the world is Carmen Sandiego? ",
		"The name of a band in which every member plays the spoons",
		"A little-known use for ear wax",
		"The type of life they\u2019ll probably find on Mars",
		"The name of a board game for players age 70 & older ",
		"Bob the Builder probably wouldn\u2019t be as popular with children if he were Bob the __          __",
		"The worst thing to do when a bear is right next to you",
		"Unlike \u201cMaverick\u201d or \u201cIceman,\u201d a really bad Air Force fighter pilot name would be __          __",
		"It would\u2019ve been a much different movie if instead of \u201cPhone home,\u201d E.T. kept saying, \u201c__          __\u201d",
		"A weird way to dry your hair",
		"A new name for the U.S. Congress ",
		"What Adam thought when he first met Eve",
		"What do ceramic garden gnomes do at night?",
		"A mystery that Sherlock Holmes could never solve: The Case of the __          __",
		"The real secret to a happy marriage is...",
		"A rejected name for the game Yahtzee",
		"The best thing to blurt out in order to ruin a beautiful sunset",
		"A mobster\u2019s pet peeve",
		"You know you\u2019re comfortable in a relationship when you ask your significant other to __          __",
		"The best line to say when you come out of a 10-year coma ",
		"The real reason Mr. Clean is grinning",
		"The best name to give an ugly baby",
		"The first thing Abraham Lincoln would do if he came back from the dead",
		"Come up with a *TMZ* celebrity headline from five years in the future",
		"What the roller coaster attendant is actually saying during his mumbled preamble before the ride",
		"An ad slogan for cardboard: \u201cNow with more __          __\u201d ",
		"The most annoying person in a movie theater would __          __",
		"A rejected Monopoly game piece ",
		"A terrible sign-off line for a newscaster",
		"A good sign that you may be a ghost",
		"The creepiest thing to whisper in somebody\u2019s ear as you\u2019re hugging them",
		"A better name for the ukulele",
		"What happens when Wile E. Coyote finally catches The Road Runner?",
		"What the Queen\u2019s Guard is secretly thinking as they just stand there",
		"The worst part about having a mustache",
		"An awkward thing to hear from the person pooping in the bathroom stall next to you",
		"A quick way to save money on grocery bills",
		"A good sign you\u2019re never going to be a professional football player",
		"The worst Viking: Eric the __          __",
		"How they really select the next Pope",
		"The name of a new cologne inspired by celebrity chef Guy Fieri",
		"A great way to quickly get out of credit card debt",
		"The worst upstairs neighbors would be people that __          __",
		"The weirdest message your cat could write out to you in its litter box",
		"A good nickname for your abs",
		"The lesser-known sequel to *Old Yeller*: *Old Yeller 2: __          __*",
		"A horrible pick-up line",
		"The best way to keep a co-worker from stealing your lunch",
		"The least scary horror movie: *Night of the __          __*",
		"The worst thing to find when you move into a new house",
		"The worst carnival prize you could win",
		"The most unusual environmental cause is \u201c__          __ the Whales\u201d",
		"The only thing worse than standing in a really long line is standing in a really long line for __          __",
		"You wake up 100 years in the future and are shocked to find __          __",
		"A weird thing for a preacher to say to end every sermon",
		"A rejected tourism slogan for Des Moines, Iowa: \u201cHome of the __          __\u201d",
		"A forgotten book in the classic Harry Potter series: *Harry Potter and the __          __*",
		"The weirdest thing a restroom attendant could offer you",
		"The worst Thanksgiving Day balloon would be a giant, inflatable __          __",
		"The big, crazy twist at the end of the next M. Night Shamalayan movie: He was __          __ the whole time!",
		"Most people know it as The Big Apple, but a lesser-known nickname for New York is The Big __          __",
		"The next best thing to chew when you\u2019re out of gum",
		"You know you\u2019re in a very weird fast food restaurant when the cashier asks, \u201cDo you want __          __ with that?\u201d",
		"It\u2019s not the heat. It\u2019s not the humidity. It\u2019s the __          __",
		"It\u2019s incredibly rude to __          __ with your mouth open",
		"You never have a __          __ when you need one",
		"*The Empire Strikes Back* would\u2019ve been ruined if Darth Vader said \u201cLuke, I am __          __\u201d",
		"The worst 1960s teen movie was definitely *__          __ Beach*",
		"The most disgusting breakfast cereal: __          __ Flakes",
		"In the next big sports scandal, we\u2019ll find out that __          __",
		"Worse than global warming, the real threat to humanity is global __          __",
		"Forget dogs. What is really man\u2019s best friend?",
		"How you can tell it\u2019s a doctor\u2019s first day on the job",
		"The worst name for an all-girl band",
		"A bad thing to say to your date\u2019s parents",
		"Pitch the worst video game idea in five words or less",
		"How embarrassing for you. You just __          __",
		"The worst mistake you could make while streaming on Twitch.tv",
		"The worst song to do pairs figure skating to",
		"What landed you in the emergency room this time?",
		"The worst thing to say during a job interview",
		"A magazine category that hasn\u2019t been invented yet",
		"The top 3 ingredients in garbage truck juice",
		"A really bad superhero power",
		"The worst thing to put on a pizza",
		"If evolution is true, then why hasn\u2019t __          __ evolved into __          __?",
		"R2D2\u2019s biggest complaint",
		"Come up with a bad tourism slogan for the Old Faithful geyser",
		"The worst possible choice for the person on the new $20 bill",
		"A little-known lyric in the original draft of the \u201cStar-Spangled Banner\u201d",
		"The best thing to shoot out of a cannon",
		"The winners on *The Bachelor* get a rose. The losers should get __          __",
		"From the creators of \u201cWhack-a-Mole\u201d comes the new game \u201c__          __-a-__          __\u201d",
		"The title of a never-released Jimmy Buffett song",
		"The worst thing to hear from your GPS: \u201cIn two miles, __          __\u201d",
		"The weirdest sentence a judge could impose",
		"A good use for toenail clippings",
		"A fitting punishment for people who double-dip their chips",
		"America\u2019s energy crisis would be over if we made cars that ran on __          __",
		"Something it\u2019d be fun to watch ride an escalator ",
		"A high school superlative you don\u2019t want to win: Most Likely To __          __",
		"A rejected title for *Moby Dick*",
		"Something you do not want to find under your hotel bed",
		"You know your doctor has gone insane when he tells you to make sure you __          __ at least once a day",
		"The worst part about being a Teenage Mutant Ninja Turtle",
		"A sign that your kid isn\u2019t good at sports",
		"The first sign that you\u2019re no longer cool",
		"A video sure to get over 150 million views on YouTube would be \u201cChickens __          __\u201d",
		"A surprising thing to find stuck to the bottom of your shoe",
		"The worst thing that could follow \u201cHoney-Roasted\u201d",
		"Why are geese such jerks?",
		"A sign that you\u2019re a bad teacher",
		"The worst breakfast: pancakes shaped like __          __",
		"What bears dream about all winter",
		"A good sign that you\u2019ve drunk too much Mt. Dew",
		"What\u2019s in the box? WHAT\u2019S  IN THE BOX?!",
		"The manliest way to start a conversation",
		"What the abominable snowman does when he\u2019s bored",
		"A good alternative for ping-pong paddles",
		"You know you\u2019re a chocoholic when...",
		"The worst reason to use a time machine",
		"Something you should not do while crowdsurfing",
		"What those bolts in Frankenstein\u2019s neck are for",
		"What Waldo from \u201cWhere\u2019s Waldo?\u201d says to himself in the mirror",
		"The worst road trip would start with someone __          __",
		"A creepy thing to write in your email signature line",
		"The only five words in your obituary in the newspaper",
		"What\u2019s the U.S. government really hiding in Area 51?",
		"The worst advice an IT guy could give",
		"A really bad name for an apartment complex: \u201c__          __ Place\u201d",
		"What should we do with all of that plastic that won\u2019t disintegrate?",
		"One thing that the rich truly enjoy is diamond-encrusted __          __",
		"The best part of turning 100 years old",
		"The lesser-known other way to find the Wizard of Oz: Follow the __          __ Road",
		"Forget coffee. Don\u2019t talk to me until I\u2019ve had my __          __",
		"Odd new shampoo instructions: \u201cLather, Rinse, __          __, Repeat.\u201d",
		"The worst magic trick",
		"The lost Hemingway book: *The Old Man and the __          __*",
		"The title of a podcast you would never ever listen to",
		"The name of a new, terrifying species of spider",
		"The most annoying co-worker would constantly __          __",
		"A surefire way to ruin Christmas",
		"The name of the worst baby doll",
		"\u201cDon\u2019t blame me, I voted for __          __.\u201d",
		"The name of a fast food restaurant in the Stone Age",
		"Dodgeball would be an even better sport if __          __ were allowed",
		"A __          __ a day keeps the doctor away",
		"What is the Abraham Lincoln statue thinking while he\u2019s sitting there in the Lincoln Memorial?",
		"Instead of \u201cCheese!\u201d the worst family photographer would tell you to say, \u201c__          __!\u201d",
		"The title of a college admission essay that would definitely get rejected",
		"Something Big Bird will confess on his deathbed",
		"What you would expect Justin Bieber\u2019s line of fragrances to smell like",
		"The last thing you\u2019d want to find in your air ducts",
		"The worst college football team: The Fighting __          __",
		"A terrible name for a dragon",
		"In the future, moviegoers will flock to see *Jurassic Park 10: __          __*",
		"The worst way to unclog a toilet",
		"Something that\u2019s been hiding in the background in every episode of *Friends*",
		"We should combine Minnesota and Wisconsin and call them __          __",
		"The name of a cable network that no one watches",
		"If the groundhog \u201ckind of\u201d sees his shadow, it\u2019s six weeks of __          __",
		"What\u2019s really destroying the ozone layer?",
		"You know you\u2019re famous when...",
		"The absolute worst moment for a bird to poop on you",
		"A weird thing for someone to frame and hang on the wall",
		"The best thing to yell while going over Niagara Falls in a barrel ",
		"What you don\u2019t want to hear from the passenger next to you at the start of a 20-hour flight",
		"Why ducks really fly south in the winter",
		"Where Charlie Brown winds up at age 45",
		"What a frog would say to his psychiatrist",
		"What is the Loch Ness Monster, really?",
		"The Pyramids would be even more impressive if they contained __          __",
		"What Sam Elliott probably nicknames his mustache",
		"The worst theme for your kid\u2019s first dance recital",
		"The worst combination of two actors that could possibly star in the next season of *True Detective* together",
		"It\u2019s disappointing to put together a 1,000 piece puzzle and realize it\u2019s just a picture of __          __",
		"The name of a law firm you shouldn\u2019t hire",
		"The worst thing to find frozen in an ice cube",
		"Something you don\u2019t expect to see when you spy on your neighbors",
		"An experiment mice actually like having performed on them",
		"A double rainbow doesn\u2019t have gold at the end of it. Instead, it has __          __",
		"The best shirt to wear next to somebody who\u2019s wearing an \u201cI\u2019m with stupid\u201d T-shirt",
		"The worst thing a plastic surgeon could say after he botched your surgery: \u201cI\u2019m sorry, I accidentally __          __\u201d",
		"The worst advice your boxing coach could give you",
		"What an alarm clock could say that would wake you right up",
		"A weird thing to hear from your doctor: \u201cI\u2019m afraid you have __          __\u201d",
		"In a shocking poll, it was discovered that three out of four Americans __          __",
		"The most common thing you\u2019d hear if you could read people\u2019s thoughts",
		"The name of a hairstyle that will never catch on",
		"A bad name for an Italian restaurant",
		"A realistic, honest fast-food slogan",
		"A good sign that you\u2019ve drunk too much Mt. Dew",
		"What bears dream about all winter",
		"The worst breakfast: pancakes shaped like __          __",
		"A sign that you\u2019re a bad teacher",
		"If a genie gives you three wishes, the best things to wish for are: 1) a billion dollars, 2) eternal life, and 3) __          __",
		"The worst charity: Save the __          __",
		"Little-known fact: An unaired episode of *The Brady Bunch* had the family dealing with __          __",
		"The futuristic invention you can\u2019t wait to see exist",
		"What\u2019s really at the center of the Earth?",
		"Invent a new word for the toilet that sounds like it\u2019s from Shakespeare",
		"Safety tip! Don\u2019t eat a half hour before you __          __",
		"The real way you can tell an alligator from a crocodile",
		"A very unnecessary surgery",
		"Survival tip! Start a fire by rubbing __          __",
		"Helpful advice you would give to Super Mario",
		"In the future, scientists discover that the secret to eternal youth is __          __",
		"Something you shouldn\u2019t use a chainsaw for",
		"A surprising purchase on Willy Wonka\u2019s credit card statement",
		"The worst album: \u201c__          __ Sings the Blues\u201d",
		"A really stupid idea for a phone app (that would still make you millions of dollars)",
		"The name of a new game show that sounds terrible",
		"The one thing you wish a politician would just say already",
		"A secret way to get stubborn ketchup out of the bottle",
		"The most surprising person to admit to being the Zodiac Killer",
		"A lesson that probably wouldn\u2019t be taught on *Sesame Street*",
		"Something you promise to yell if you win this game",
		"A creepy thing to find scribbled onto a dollar bill",
		"If you don\u2019t have extra money, an odd thing to use as a tip for your waiter",
		"The name of the next hot boy band",
		"A terrible name for a king",
		"A sure sign that a drifter has been secretly living in your house",
		"The name of a new U.S. state you would never visit",
		"The one thing that isn\u2019t better dipped in chocolate",
		"Like \u201cdinger,\u201d \u201cgrand salami,\u201d and \u201cjack,\u201d come up with a new slang term for a home run in baseball",
		"A terrible vacation idea: going to visit The Museum of __          __",
		"A great gag gift would be an exploding __          __",
		"The official medical term for belly button lint (probably)",
		"A surprising thing to hear in a nature documentary",
		"The years 2011 to 2020 will be remembered as \u201cThe __          __ Age\u201d",
		"An inventive way to get rid of head lice",
		"Little-known fact: the scariest animal in the world is the __          __ cobra",
		"A bad name for a brand of hot sauce",
		"An excuse to avoid riding the mechanical bull",
		"What Big Foot complains about to his therapist the most",
		"The worst warning to read on some medicine you just swallowed",
		"A strange poster to hang in a college dorm room",
		"Never pay more than $3 for __          __",
		"The name of a really bizarre diet that just never caught on",
		"The most popular T-shirt slogan in Mississippi, probably",
		"The hit song from the Broadway show *Fart: The Musical*",
		"A ridiculous government agency that no one knows about: The Department of __          __",
		"The best thing about being thrown into a volcano",
		"The world\u2019s most boring video game",
		"New requirement at amusement parks: \u201cYou must be this __          __ to ride\"",
		"You probably shouldn\u2019t hire a moving company called __          __",
		"The weirdest combination of three items that you could buy at the store",
		"The worst halftime show: The __          __ Dancers",
		"What\u2019s really in a camel\u2019s hump?",
		"The most obnoxious name someone could give their kid",
		"Something that is probably on Nicolas Cage\u2019s \u201cTo Do\u201d list",
		"The newest health food: __          __ juice",
		"HR would probably get the most complaints on \u201cBring your __          __ to work\u201d day",
		"A lesser-known Knight of the Round Table: Sir __          __",
		"A Socrates quote that nobody bothered to write down",
		"Why is the sky blue?",
		"The best way to catch a leprechaun",
		"The worst things to juggle",
		"Turns out, the meaning of life is __          __",
		"The worst tattoo to have on your forehead",
		"A mean text you would send to break up with a Muppet",
		"What really cracked the Liberty Bell?",
		"A weird photo to keep in your wallet",
		"An odd painting to hang above your bed",
		"A poor substitute for a necktie",
		"The perfect day off is just twelve straight hours of __          __",
		"The worst Vegas casino: __          __ Palace",
		"Something awful to hold in your mouth for an hour",
		"A great way to start a conversation with a weird loner on the subway",
		"A hip, new advertising slogan for socks",
		"Really awful cheerleaders would yell \u201c__          __!\u201d",
		"Why should you never turn your back on a penguin?",
		"The reason Pluto isn\u2019t a planet anymore",
		"The biggest issue facing the town of Margaritaville ",
		"The least appetizing name for a restaurant",
		"Something you should not say in front of a parrot",
		"Something you should not put in your kid\u2019s sandbox",
		"What the boogeyman is afraid of","A bad name for a hospital",
		"Something you do not want to do while standing in a police lineup",
		"Where\u2019s Jimmy Hoffa? ",
		"An odd casting choice would be Clint Eastwood as __          __",
		"After the Heimlich Maneuver, the second-best way to stop someone from choking",
		"A rejected safety technique for when you catch fire was to \u201cstop, drop, and __          __\u201d",
		"The difference between Grade A beef and Grade B beef",
		"The weirdest room you could see in an airport would be one specifically designated for __          __",
		"If you really want to impress the Olympic diving judges, try a dive that involves __          __",
		"What you think the word \u201cpandiculation\u201d means",
		"A body of water you definitely shouldn\u2019t swim in",
		"Something fun to ask the old wise man on top of the mountain",
		"A rejected tagline for *Star Trek* instead of \u201cSpace: the final frontier\u201d was \u201cSpace: __          __\u201d",
		"How would YOU fix the economy?",
		"The hardest part about living in a submarine",
		"If you really, really love something, let it __          __",
		"A name for a really scary swamp: __          __ Swamp",
		"The name of the music playlist that will definitely put an end to the party",
		"A bad name for a water park",
		"A polite way to say \u201cbooger\u201d",
		"A fun outfit to dress up the statue of David in",
		"Kennedy\u2019s original speech said, \u201cAsk not what your country can do for you, ask __          __\u201d",
		"What the hot trend in weddings will be in the year 2046",
		"Something fun to scream at a farmer\u2019s market",
		"Mother Teresa\u2019s deepest secret ",
		"The most creative thing you can make entirely out of boogers",
		"An ill-advised outfit to wear to your first day at a new job",
		"Sleepwalking can be a problem but it\u2019s not as bad as sleep__          __",
		"In the future, RoboCop actually retires from the police force and becomes Robo-__          __",
		"What to do when your parachute fails",
		"Something people used to do for fun before electricity",
		"The most embarrassing crime to get caught committing",
		"The name that cavemen probably gave to diarrhea",
		"The worst person to share a hot tub with",
		"A peculiar thing to see in a Help Wanted ad would be \u201cHelp Wanted: __          __\u201d",
		"What mustaches SHOULD be called",
		"The worst pizza is __          __-style pizza",
		"A real weirdo would fall asleep to the sounds of __          __",
		"The name of a dog food brand you probably should not buy",
		"Come up with a name for a generic brand of hot dogs that you probably shouldn\u2019t buy",
		"Everything tastes better with __          __",
		"Life hack! Lower your heating bills by...",
		"The worst thing that could crawl out of your toilet",
		"The worst advice a doctor could give",
		"Something a weatherman might yell if he completely snapped during the weather forecast",
		"A great birthday present for your worst enemy",
		"The name of a painting Michelangelo was ashamed he created",
		"A clever thing for James Bond to say as he throws someone out of an airplane",
		"No one would guess this is where the treasure is buried",
		"The secret to a healthy head of hair",
		"A strange thing to read on a door mat",
		"The secret to a great marriage",
		"What really happens if you stare at the sun too long",
		"A prank the Supreme Court Justices probably play on each other",
		"What the Easter Bunny does with his free time",
		"A little known-perk of being U.S. president",
		"A horrible charity: __          __ for Tots",
		"A word that should be in the dictionary but isn\u2019t",
		"A really odd thing to say on your deathbed",
		"The Four Horsemen wouldn\u2019t be as scary if they were the Four __          __men of the Apocalypse",
		"It\u2019s illegal to yell \u201cFire!\u201d in a crowded theater, but it should also be illegal to yell, \u201c__          __!\u201d",
		"A good name for a pet cemetery",
		"A new word for people that drive too slow in the fast lane",
		"The perfect name for a second head that sprouts on your shoulder",
		"The worst material from which to make a pair of pajamas",
		"Queen Elizabeth\u2019s deepest, darkest secret",
		"Come up with a slogan for the Russian Tourism Board",
		"The best part about being Donald Trump",
		"Tip: Never eat at a place called \u201cKentucky Fried __          __\u201d",
		"Sometimes John Travolta wildly mispronounces names. How might he wildly mispronounce his own name?",
		"The worst toy store: Build-A-__          __ Workshop",
		"The weirdest thing you can buy at the Vatican gift shop",
		"The worst invention that starts with \u201cSpray-On\u201d",
		"The name of a species of dinosaur you wouldn\u2019t want to meet",
		"Something overheard at the Last Supper",
		"A possible entry in Gary Busey\u2019s dream journal: \u201cTonight I dreamed __          __\u201d",
		"Something you can make out of body hair",
		"The worst way to fly: __          __ Airlines",
		"So... what was that movie *Birdman* about anyway?",
		"A great pet name for a parasitic worm that lives in your ear",
		"An idea for Lady Gaga\u2019s next crazy outfit: a __          __ dress",
		"Little-known fact: Over the course of a lifetime, an average person accidentally eats ten __          __",
		"Something you probably shouldn\u2019t try to sell on eBay",
		"The worst air freshener scent",
		"A terrible thing to sign on the cast of your friend\u2019s broken leg",
		"It would be awesome to win *Jeopardy* with the phrase, \u201cWhat is __          __, Alex?\u201d",
		"A sign you probably shouldn\u2019t put up in your yard",
		"A bad title for a self-help book",
		"An unusual \u201cSpecial Skill\u201d to include on your resume",
		"What kittens would say if they could talk",
		"A strange thing to keep as a pet",
		"The worst thing about Canada",
		"You should never share __          __ with someone else",
		"The grossest thing you could find at the bottom of a swimming pool",
		"The sound a tree actually makes when it falls and no one is around to hear it",
		"You need three things to live: food, water, and __          __",
		"A good use for toenail clippings",
		"What you would do with two free hours and a flamethrower",
		"The worst name for an SUV",
		"New sport idea: professional __          __",
		"Trash talk you would hear at a chess meet",
		"Something you shouldn\u2019t stuff with cheese",
		"Something pirates probably aren\u2019t very good at",
		"Everyone knows there\u2019s no such thing as __          __",
		"A completely untrue rumor about Alvin from Alvin and the Chipmunks",
		"You should never __          __ and __          __ at the same time",
		"The worst thing about being a billionaire",
		"Briefly describe your imaginary friend",
		"New movie idea: *The Muppets Take __          __*",
		"What you call a baby sasquatch",
		"What is a tree thinking all day?",
		"The best use for a leftover meatball",
		"A bad reason to call 911",
		"The best way to quickly blow a million dollars",
		"Your first decree after being named Supreme Ruler of Earth",
		"The worst thing to receive for trick-or-treat",
		"Come up with a name for a kooky ostrich who solves mysteries",
		"A phrase you would love to hear Morgan Freeman say",
		"USA! USA! America is still number one in...",
		"An Olympic sport that never made it: Synchronized __          __",
		"The government should legalize...",
		"The first thing to do if you\u2019re attacked by a shark",
		"The worst thing to find growing on your neck",
		"A little-known fact about the Jolly Green Giant",
		"The perfect meal would be a __          __ stuffed in a __          __ stuffed in a __          __",
		"What\u2019s black and white and red all over?",
		"New show idea: *America\u2019s Next Top __          __*",
		"It never ends well when you mix __          __ and __          __",
		"Invent a silly British term for pooping",
		"The best reason to go to Australia",
		"The beauty pageant no one wants to see: Miss __          __",
		"The most boring graffiti you could see in the subway",
		"A slogan to get everyone excited about corn",
		"You never forget your first __          __",
		"Little-known fact: The human body is approximately 80% __          __",
		"Coming soon to a theater near you: Benedict Cumberbatch is __          __",
		"Something you shouldn\u2019t buy at a yard sale",
		"If we only use 10% of our brains, what\u2019s the other 90% doing?",
		"What you want your gravestone to read",
		"The worst menu item that starts with \u201cAll You Can Eat\u201d",
		"A sign you wouldn\u2019t want to see at a seafood restaurant",
		"Something fun to yell during an opera",
		"A group activity at a really bad summer camp",
		"A Girl Scouts cookie name that got rejected because it was just too ridiculous-sounding",
		"The least impressive Boy Scout badge",
		"The worst ringtone for a cell phone",
		"A great nickname for your armpit hair",
		"\u201cKnock, knock!\u201d \u201cWho\u2019s there?\u201d __          __",
		"A Tweet from a caveman",
		"A message found in a bottle floating in the sea",
		"The worst car feature that ends with \u201cholder\u201d",
		"What Chewbacca has really been yelling all these years",
		"The most stereotypical country song title",
		"The best way to survive a bear attack is __          __",
		"The worst name for a funeral home",
		"An angry internet comment on a pet store\u2019s website",
		"The worst name for a rap artist",
		"A rejected shape for Marshmallow Peeps",
		"Something that should never be \u201chomemade\u201d",
		"Three things MacGyver needs to make a bomb",
		"Another use for marshmallows",
		"Another use for gravy",
		"A great way to cure the hiccups",
		"An animal Noah shouldn\u2019t have saved",
		"The biggest secret the government keeps",
		"Something you wouldn\u2019t expect a Ouija board to say",
		"The best way to defeat terrorism is...",
		"Come up with a name for a salad dressing by Lindsay Lohan",
		"The best way to tell if a tomato is ripe",
		"A good post-music career for Justin Bieber",
		"Come up with a name for a sitcom about a bunch of wacky nuns",
		"A completely wrong way to spell \u201cJennifer Aniston\u201d",
		"The 11th Commandment: Thou shalt not...",
		"The best way to scare a burglar",
		"The worst thing to yell while a professional golfer putts",
		"The second thing said on the moon",
		"Something you can only do in a Walmart if no one\u2019s looking",
		"A name for a really cheap hotel",
		"The worst name for a mountain",
		"Why so serious?",
		"The best thing about being really dumb",
		"A thought that keeps Santa Claus awake at night",
		"The real secret to living to age 100",
		"What really happens if you tear off that mattress tag",
		"A bad first line for your presidential inauguration speech",
		"A fun thing to do with a bowl of pudding",
		"Another use for cooked spaghetti",
		"A weird physical way to greet someone",
		"The worst name for a tanning salon",
		"The worst word that can come before \u201cfart\u201d",
		"A bad substitute for a toothbrush",
		"A trick you shouldn\u2019t teach your dog",
		"The worst material with which to make a snowman",
		"A terrible sportscaster catchphrase for when somebody dunks a basketball",
		"The first thing a pig would say if it could talk",
		"The worst shape for an animal cracker",
		"A surprising job entry on Abraham Lincoln\u2019s resume",
		"Something you\u2019d yell to heckle the performing dolphins at Sea World",
		"The worst name for a \u201cbig and tall\u201d store",
		"The name of a shampoo for hippies",
		"A new name for kumquats",
		"An angry review you\u2019d give this game (Quiplash)",
		"The worst thing to wear to your court trial",
		"A rejected crayon color",
		"Graffiti you might find in a kindergarten",
		"The first sign that you\u2019re old",
		"The worst question to ask during a White House tour",
		"Tomorrow\u2019s news headline: \u201cScientists Are Shocked to Discover That __          __\u201d",
		"A terrible talent to have for the Miss America Pageant",
		"Bad advice for new graduates",
		"The best way to tell if someone is dead",
		"A TMZ headline you really want to see",
		"What you hope the Mars Rover finds",
		"Where missing socks go",
		"A rejected phrase for one of those Valentine heart candies",
		"Something that will get you thrown out of a Wendy\u2019s",
		"It would be scary to read on a food package, \u201cMay contain trace elements of __          __.\u201d",
		"A just-so-crazy-it\u2019s-brilliant business idea to pitch on *Shark Tank*",
		"A terrifying fortune cookie fortune",
		"Something the devil is afraid of",
		"CBS should air a TV show about lawyers who are also __          __",
		"A great thing to yell before jumping out of an airplane",
		"A gift nobody would want: The __          __ of the Month Club",
		"A better name for the game Duck Duck Goose",
		"A bad way to remove unsightly chest hair",
		"An unusual theme for a kid\u2019s lunchbox",
		"What the government is hiding from the public in Area 497",
		"What your pancreas tests revealed",
		"A bad, one-word slogan for a presidential campaign",
		"Something you'd make a butler do the moment you hired him",
		"Why did the mortician cross the road?",
		"Something you should never try to heat in the microwave ",
		"A surprising thing to find inside a piñata ",
		"An alternate name for The Mona Lisa",
		"A reason to travel back in time to two weeks ago",
		"If you\u2019d never heard the term \u201cgreat white shark,\u201d what might you call it when you saw one for the first time?",
		"A place where you're not likely to spot Bigfoot",
		"Something you should never say as the captain of a bowling team",
		"The dumbest person in the history of all time ",
		"Another name for the Grand Canyon",
		"Another name for Canada",
		"A bad use for clam chowder",
		"\"On the 147th day of Christmas, my true love gave to me...\"",
		"The best name for an obese rapper",
		"It would be most awesome for Chuck Norris to fight __          __",
		"A good puck replacement if they run out of pucks in a game of hockey",
		"If animals took over, an exhibit you\u2019d see at the human zoo",
		"A terrible wedding gift",
		"A street name you never see",
		"The first thing that pops into your mind right now",
		"A weapon that should be added to the game Clue",
		"The toy surprise in an Unhappy Meal",
		"Make up a word for the watery substances that come out of a ketchup bottle when you first squeeze it",
		"Make up a name for the space between your nostrils",
		"Italy\u2019s newest tourist attraction: The __          __Tower of Pisa",
		"The worst theme for a pinball machine",
		"The name of Jesus' 13th apostle",
		"Something you don't want to find in your Christmas stocking",
		"A title of a self-help book for rats",
		"The worst thing you could rub all over your face",
		"George W. Bush and Dick Cheney's rap duo name",
		"Something you rarely see used as a car decoration",
		"A historical event that would make a bad theme for a restaurant",
		"The worst thing to try to sell door-to-door",
		"Something you probably shouldn\u2019t bring on a trip across the Sahara desert",
		"What's that stain?",
		"Something you'd love to smash with a wrecking ball",
		"A bad name for a pet goldfish",
		"Life would be so much better if we all lived in __          __",
		"Something it\u2019s not a good idea to put in the overhead bin on an airplane",
		"A weird thing for a bank robber to demand in a hostage situation",
		"Something they will probably never make a series of commemorative stamps for",
		"A club you wish they had in high school",
		"The best prize you could find in a Cracker Jack box",
		"The worst soup flavor: Cream of __          __",
		"A strange place to hold a family reunion",
		"Something you\u2019d sneak into space, if you were an astronaut",
		"What they really found in King Tut\u2019s tomb",
		"The name of that cheese shop you\u2019re going to open some day",
		"The liquid that would make for the worst salad dressing",
		"An unusual motif for a baby\u2019s nursery",
		"Another name for toe jam",
		"A better name for dandruff",
		"A terrible name to have if you\u2019re running for public office",
		"Four out of five dentists agree you should never __          __",
		"Something that would make a creepy replacement for the horses on a merry-go-round",
		"The worst thing to vomit into when you suddenly need to vomit",
		"Make up a word that means \u201cto make up a word\u201d",
		"Like Plutonium or Einsteinium, what would you name the next Periodic Table element they discover?",
		"A bad name for a pirate",
		"Something fun to scream when you win in a game of bingo, other than \u201cBingo!\u201d",
		"A movie that should never be made into a theme park ride",
		"A business or service that shouldn't have a drive-through window",
		"Paul Bunyan\u2019s replacement for Babe The Blue Ox when he dies",
		"The worst flavor for a sno-cone",
		"What Smokey the Bear does when he\u2019s not fighting forest fires",
		"Combine any two words to make a fun, new made-up word",
		"A lesser-known ingredient in most microwave pizza pockets",
		"A great place to hide an Easter egg",
		"A trick you\u2019d like to see a poodle do",
		"A better name for the Washington Monument",
		"You never know when you\u2019re going to need insurance. You could wake up tomorrow and __          __",
		"The worst thing to overhear during your surgery",
		"A bad name for a brand of bottled water",
		"How do you like it?",
		"Come up with a new dessert that contains the name of a U.S. state",
		"The first and second rules of Fight Club are \u201cDon\u2019t talk about Fight Club,\u201d but what\u2019s the 387th rule of Fight Club?",
		"A terrible food truck would be one that goes around selling only __          __",
		"A reason to get into a fist fight with a koala bear ",
		"Little-known fact: the fourth Wise Man gave baby Jesus the worst gift of all: __          __ ",
		"A theme for a desk calendar that wouldn\u2019t sell very well ",
		"The worst thing you could stick in a toaster ",
		"The worst Halloween costume for a young child",
		"\u201cThis just in! A __          __ has won the election and will become the new governor of Texas.\u201d ",
		"A better name for the human bladder",
		"Surprising first words for your baby to speak",
		"A good name for a dog country singer",
		"A lawn decoration sure to make the neighbors mad",
		"The worst thing to say when trying to adopt a pet",
		"Fun thing to do if locked in the mall overnight",
		"The worst person to receive a sponge bath from",
		"People wouldn\u2019t respect He-Man as much if, to gain his power, he held up his sword and shouted \u201c__          ____          ________\u201d",
		"Pants would be a whole lot better if they __          __",
		"A little-known way to get gum out of your hair",
		"The most awesome Guinness World Record to break",
		"It\u2019s bad to be buried alive. It\u2019s worse to be buried alive with __          __.",
		"Something that would not work as well as skis",
		"What to say to get out of jury duty",
		"A rejected name for a ship in the U.S. Naval Fleet: the USS __          __",
		"A rejected title for *The Good, The Bad and the Ugly* was *The Good, the Bad and the __          __*",
		"Little-known fact: The government allows peanut butter to contain up to 10% __          __",
		"A good sign that your house is haunted",
		"A bad occupation for a robot to have",
		"A sequel to the painting \u201cDogs Playing Poker\u201d",
		"The Tooth Fairy\u2019s other job",
		"Little-known fact: A secret area in the White House is the __          __ room",
		"An invention by Thomas Edison that never caught on",
		"A birthday present you shouldn\u2019t get for your grandmother",
		"What time is it?",
		"Invent a Christmas tradition sure to catch on",
		"A short motto everyone should live by",
		"The best way to start your day",
		"A good improvement to make to Mt. Rushmore",
		"The worst name for a summer camp",
		"The first commandment in the new religion you started",
		"Three things are certain in life: Death, Taxes, and __          __",
		"A faster way to get home from the Land of Oz is to click your heels three times and say __          __.",
		"Something that\u2019s made worse by adding cheese",
		"Which new marshmallow should Lucky Charms cereal introduce?",
		"The perfect song to hum on the toilet",
		"A word that should never follow \u201cBeef\u201d",
		"Something that is currently legal that should be banned",
		"Come up with a name for a rock band made up entirely of baby ducks",
		"We can all agree that __          __",
		"Something you shouldn\u2019t buy off of Craigslist",
		"A bad thing to say to a cop as he writes you a speeding ticket",
		"How far is too far?",
		"If at first you don\u2019t succeed...",
		"The name you would give to a really mopey pig",
		"What robots dream about",
		"What really happened to Amelia Earhart",
		"Something you\u2019d be surprised to see come out of a pimple you pop",
		"Today\u2019s music needs more __          __",
		"Finish this sentence: \u201cWhen I\u2019m rich, my mansion will have a room called The __          __ Room.\u201d",
		"The best question to ask God when you meet him",
		"A fun trick to play on your doctor",
		"A bad place for your rocket ship to crash would be The Planet of the __          __",
		"A bad campaign slogan for a congressperson",
		"A unique way to escape from prison",
		"The next product for Matthew McConaughey to endorse",
		"The title of a new YouTube cat video that\u2019s sure to go viral",
		"Come up with the name of a country that doesn\u2019t exist",
		"The best way to keep warm on a cold winter night",
		"The real reason the dinosaurs died",
		"Something you should never put on an open wound",
		"Scientists say erosion, but we all know the Grand Canyon was actually made by __          __",
		"The name of a font nobody would ever use",
		"The best thing about going to prison",
		"The best title for a new national anthem for the USA",
		"A college major you don\u2019t see at many universities",
		"What would make baseball more entertaining to watch?",
		"A little-known fact about Canada",
		"Name a TV drama that\u2019s about a vampire doctor",
		"A name for a brand of designer adult diapers",
		"What\u2019s actually causing global warming?",
		"The first thing you would do after winning the lottery",
		"A name for a really bad Broadway musical",
		"On your wedding night, it would be horrible to find out that the person you married is __          __",
		"The Skittles flavor that just missed the cut",
		"What FDR meant to say was \u201cWe have nothing to fear, but __          __\u201d",
		"A terrible name for a cruise ship",
		"What\u2019s the Mona Lisa smiling about?",
		"The crime you would commit if you could get away with it",
		"Something squirrels probably do when no one is looking",
		"Something you shouldn\u2019t get your significant other for Valentine\u2019s Day",
		"A dangerous thing to do while driving",
		"The best thing about living in an igloo",
		"Using only two words, a new state motto for Texas",
		"The hardest thing about being Batman",
		"Something you shouldn\u2019t wear to a job interview",
		"The #1 reason penguins can\u2019t fly",
		"The name of the reindeer Santa didn\u2019t pick to pull his sleigh",
		"What\u2019s the first thing you would do if you could time travel?",
		"What would you do if you were left alone in the White House for an hour?",
		"Come up with the name of book that would sell a million copies, immediately",
		"A not-very-scary name for a pirate",
		"The name of a pizza place you should never order from",
		"A Starbucks coffee that should never exist",
		"There\u2019s Gryffindor, Ravenclaw, Slytherin, and Hufflepuff, but what\u2019s the Hogwarts house few have ever heard of?",
		"Something you should never use as a scarf",
		"The worst words to say for the opening of a eulogy at a funeral",
		"Come up with a really bad TV show that starts with \u201cBaby\u201d",
		"A great way to kill time at work",
		"What\u2019s wrong with these kids today?",
		"Why does the Tower of Pisa lean?",
		"A great new invention that starts with \u201cAutomatic\u201d",
		"Come up with a really bad football penalty that begins with \u201cIntentional\u201d",
		"You know you\u2019re in for a bad taxi ride when __          __",
		"The terrible fate of the snowman Olaf in a director\u2019s cut of *Frozen*",
		"Sometimes, after a long day, you just need to __          __",
		"The worst way to spell Mississippi",
		"Give me one good reason why I shouldn\u2019t spank you right now",
		"The best pick-up line for an elderly singles mixer",
		"The best news you could get today",
		"Invent a holiday that you think everyone would enjoy",
		"Usually, it\u2019s bacon, lettuce and tomato, but come up with a BLT you wouldn\u2019t want to eat",
		"The worst thing you could stuff a bed mattress with",
		"A great opening line to start a conversation with a stranger at a party",
		"Something you would like to fill a swimming pool with",
		"Miley Cyrus\u2019 Wi-Fi password, possibly",
		"If you were allowed to name someone else\u2019s baby any weird thing you wanted, what would you name it?",
		"A terrible name for a clown",
		"Miller Lite beer would make a lot of money if they came up with a beer called Miller Lite _____",
		"Okay... fine! What do YOU want to talk about then?!!!",
		"The Katy Perry Super Bowl halftime show would have been better with __          __",
		"Your personal catchphrase if you were on one of those *Real Housewives* shows",
		"A good fake name to use when checking into a hotel",
		"A vanity license plate a jerk in an expensive car would get",
		"The name of a canine comedy club with puppy stand-up comedians",
		"What\u2019s lurking under your bed when you sleep?",
		"Come up with a name for the most difficult yoga pose known to mankind",
		"One place a finger shouldn\u2019t go",
		"The worst job title that starts with \u201cAssistant\u201d",
		"The grossest thing you\u2019d put in your mouth for $18",
		"The last person you\u2019d consider inviting to your birthday party",
		"Where do you think the beef really is?",
		"A fun trick to play on the Pope",
		"Write a newspaper headline that will really catch people\u2019s attention",
		"Something it\u2019d be fun to throw off the Eiffel Tower",
		"Name the eighth dwarf, who got cut at the last minute",
		"Come up with the name for a new TV show with the word \u201cSpanky\u201d in it",
		"A good place to hide boogers",
		"Come up with a catchier, more marketable name for the Bible",
		"The best thing to use when you\u2019re out of toilet paper",
		"A good way to get fired",
		"The most presidential name you can think of (that isn\u2019t already the name of a president)",
		"Something you should never say to your mother",
		"Where\u2019s the best place to hide from the shadow monsters?",
		"The three ingredients in the worst smoothie ever",
		"Something that would make an awful hat",
		"How many monkeys is too many monkeys?",
		"Something you\u2019d be surprised to see a donkey do",
		"The title you\u2019d come up with if you were writing the Olympics theme song",
		"Name the sequel to *Titanic* if there were one. *Titanic 2: __          __*",
		"An alternate use for a banana",
		"What you\u2019d guess is an unadvertised ingredient in most hot dogs",
		"Name your new haircutting establishment",
		"An inappropriate thing to do at a cemetery",
		"Like chicken fingers or chicken poppers, a new appetizer name for your fun, theme restaurant: chicken _____",
		"Thing you\u2019d be most surprised to have a dentist find in your mouth",
		"Rename Winnie-the-Pooh to something more appropriate/descriptive",
		"The name of a clothing store for overweight leprechauns",
		"If God has a sense of humor, he welcomes people to heaven by saying, \u201c__          __\u201d",
		"Something that would not work well as a dip for tortilla chips",
		"Name a new movie starring a talking goat who is president of the United States",
		"An item NOT found in Taylor Swift\u2019s purse",
		"Name a new reggae band made up entirely of chickens",
		"Who let the dogs out?",
		"What do vegans taste like?",
		"Make up a word that describes the sound of farting into a bowl of mac & cheese",
		"A new ice cream flavor that no one would ever order",
		"Name a children\u2019s book by someone who hates children",
		"The name of your new plumbing company",
		"The worst name for a robot",
		"The first names of each of your nipples",
		"What John Goodman\u2019s belches smell like",
		"The name of a new perfume by Betty White",
		"One thing never to do on a first date",
		"Ozzy Osbourne\u2019s Twitter password, probably",
		"The most embarrassing name for a dog",
		"The worst thing you could discover in your burrito",
		"Something you\u2019d probably find a lot of in God\u2019s refrigerator",
		"Brand name of a bottled water sold in the land of Oz",
		"The worst family secret that could come out over Thanksgiving dinner",
		"A fun thing to yell as a baby is being born",
		"The name of a toilet paper specifically designed for the Queen of England",
		"A terrible name for a 1930s gangster",
		"Something upsetting you could say to the cable guy as he installs your television service",
		"Come up with a name for a new beer marketed toward babies",
		"A terrible theme for a high school prom",
		"A more environment-friendly alternative to toilet paper",
		"What tattoo should Justin Bieber get next?",
		"What do kittens dream of?",
		"What makes hot dogs taste so good?",
		"A better name for France",
		"The worst thing to find stuck in your teeth",
		"The worst excuse for showing up late to work",
		"The worst thing for an evil witch to turn you into",
		"Jesus\u2019s REAL last words",
		"The biggest downside to living in Hell",
		"Everyone knows that monkeys hate __          __",
		"Name a candle scent designed specifically for Kim Kardashian",
		"If a winning coach gets Gatorade dumped on his head, what should get dumped on the losing coach?",
		"The secret to a happy life",
		"You would never go on a roller coaster called __          __",
		"What two words would passengers never want to hear a pilot say?",
		"The worst name for a race horse",
		"Come up with a three-word sequel to the book \u201cEat, Pray, Love\u201d",
		"You wouldn\u2019t want to share a prison cell with someone named __          __",
		"Superman\u2019s special power that he never tells anyone about",
		"You shouldn\u2019t get a massage at a place called __          __",
		"The least romantic place to propose marriage",
		"A rejected name for the Segway",
		"The most inappropriate song to hear at a kid\u2019s piano recital",
		"A unique way to amputate your toe",
		"One perk of marrying a serial killer",
		"What a unicorn\u2019s butt smells like",
		"A better name for a corset",
		"A sign that you\u2019re pregnant with an evil baby",
		"How Yogi Bear eventually meets his death",
		"Most people think Julius Caesar said \u201cEt tu, Brute?\u201d when he got stabbed, but what he really said was __          __",
		"What really pisses off a ghost?",
		"Instead of \u201cHump Day,\u201d we should call Wednesday __          __",
		"What Michaelangelo said as he chiseled *David*\u2019s penis",
		"The best cure for a hangover",
		"How do proctologists cheer themselves up?",
		"A disturbing thing to hear your significant other say while sleep-talking",
		"The weirdest place to see an image of the The Virgin Mary",
		"The worst thing that happened on Noah\u2019s Ark",
		"Bad: You\u2019re lost in the woods. Worse: You\u2019re also completely naked. Worst: And you\u2019re also __          __",
		"How you can tell you\u2019re drinking really cheap wine",
		"An obscure Surgeon General warning that most people don\u2019t know about: \u201cSmoking may cause __          __\u201d",
		"A lesser-known Medieval torture device: The __          __",
		"How you can tell it\u2019s time to throw out a pair of underwear",
		"What Wild Bill Hickok named his penis, probably",
		"The crappiest western was *Gunfight at the __          __ Corral*",
		"Something you should never stuff a bra with",
		"The strangest new military weapon: __          __-seeking missiles",
		"The polite thing to bring to an orgy in the suburbs",
		"A popular TV show title with the word \u201cpoop\u201d inserted",
		"Yet another practical use for placenta",
		"A surprising new part of the field sobriety test requires you to __          __ to prove you\u2019re not drunk",
		"A name for a sexy turtle",
		"What Little Bo Peep would confess if she got really drunk",
		"The first thought that runs through your head when a lobster clamps onto your genitals",
		"An inappropriate ice sculpture for a wedding reception",
		"The punchline to an off-color *Star Wars* joke",
		"A shocking find in Clifford the Big Red Dog\u2019s poop",
		"What happens when you finally make eye contact with the crazy person on the subway",
		"An inappropriate thing for a detective to say at a crime scene",
		"The one phrase the NSA is tired of watching us type into Google",
		"Aw screw it... just type in something dirty",
		"Rename any famous work of literature so that it is ruined by the word \u201cbutt\u201d",
		"The secret to being a great kisser",
		"A funny thing to write down on a form when it asks for your sex",
		"A poor substitute for underwear",
		"The worst children\u2019s board game would be \u201c__          __, __          __ Hippos\u201d",
		"The worst thing to whisper during pillow talk",
		"Something that absolutely doesn\u2019t make you think of a penis on some level",
		"A good sign that your dog is really an a-hole",
		"The strangest reason to get a divorce",
		"Something inappropriate to do at the gym",
		"A secret ability of boobs",
		"The most G-rated term for an erection",
		"The name of a sexy new dance move",
		"What sperm yell as they swim",
		"The Old English term for \u201cvagina\u201d",
		"A strange side effect to hear during a drug commercial",
		"Another use for tampons",
		"The dumbest method of birth control",
		"The name of the website that probably gave your computer a virus",
		"How Garfield the cartoon cat will eventually die",
		"The worst slogan for an erectile dysfunction pill",
		"A crazy thing to find during a colonoscopy",
		"The worst thing you can tell the kids about the death of the family dog",
		"Advice: Never stick your tongue into __          __",
		"Something a talking doll probably should NOT say when you pull the string",
		"A kinky weird thing that does NOT happen in 50 Shades of Grey (as far as you know)",
		"The biggest complaint of people in Hell",
		"A weirdly enticing subject line for an email in your SPAM folder",
		"A new, completely BS holiday that greeting card companies would make up to sell more cards",
		"Name the next big sexually transmitted disease",
		"What happens to circumcision skin",
		"What dogs think when they see people naked",
		"The title of the most boring porno ever",
		"Something Godzilla does when he\u2019s drunk",
		"A good name for an elderly nudist colony",
		"An inappropriate thing to say via skywriting",
		"A good name for a sex robot",
		"A cute name for hemorrhoids",
		"Something in a weirdo\u2019s bedroom",
		"The worst song to play when stripping for your lover",
		"A movie that could use some nudity",
		"Pick any city name and make it sound dirty",
		"An item on every pervert\u2019s grocery list",
		"The password to the secret, high-society sex club down the street",
		"You know you\u2019re really drunk when...",
		"What they call pooping in the Land of Oz",
		"What Santa does with a dead elf",
		"The least popular item in the Victoria\u2019s Secret catalog",
		"The worst way to remove pubic hair",
		"A Facebook status you don\u2019t want your grandparents to see",
		"A tourist attraction in Hell",
		"A new slang term for impotence",
		"A weird thing to find in your grandparents\u2019 bedside table",
		"The name of a cocktail for hillbillies",
		"What a dog sext message might say",
		"The 6,077th layer of Hell is reserved for __          __",
		"An image that would make the Sistine Chapel's ceiling look more badass",
		"What deer would use for bait if they hunted hunters",
		"A punch line for a joke that would make children cry",
		"A brand name for a medication that intentionally CAUSES male impotence",
		"Make up a schoolyard game that children should never play at recess",
		"A magazine that should never have a nude centerfold",
		"An inappropriate theme for a set of kids\u2019 pajamas",
		"Another name for a rectal thermometer",
		"The most bitching thing you can airbrush on your van",
		"The Seven Deadly Sins are lust, gluttony, greed, envy, pride, wrath, and sloth. The Eighth Deadly Sin is...",
		"Come up with a name for a fast food chain that only serves rabbit meat",
		"Something fun to do with your kidney stones after you pass them",
		"An unusual object to bludgeon someone to death with",
		"The least-threatening name for a serial killer: The Boston __          __",
		"The first inductee of the A-hole Hall of Fame ",
		"A name for a new cereal that\u2019s for adults only",
		"Make up a curse word",
		"The celebrity you\u2019d eat first if you were a cannibal, and the side dish you\u2019d eat them with",
		"Santa Claus would be a bigger badass if his sleigh were driven by eight tiny\u2026",
		"A good name for a restaurant that serves animals with the faces still on them ",
		"A name for a board game designed to give children nightmares ",
		"The worst person to narrate the audiobook of *Fifty Shades of Grey*",
		"A good name for an erotic bakery",
		"What the Statue of Liberty is hiding beneath that robe",
		"There\u2019s only one time that murder is acceptable and that is when __          __",
		"Take any well-known restaurant and slightly change its name to something inappropriate",
		"A catchy name for a sperm bank",
		"A bad place to skinny-dip",
		"A bad thing to yell during church",
		"The unsexiest thought you can have",
		"Take any U.S. president\u2019s name and turn it into something inappropriate",
		"A great name to have on a fake I.D.",
		"The name of an all-male version of Hooters",
		"Two people from history that should definitely have sex",
		"The coolest way to die",
		"A little-known nickname for New Orleans",
		"Come up with a title for an adult version of any classic video game",
		"Come up with a great title for the next awkward teen sex movie",
		"Come up with a name for a beer made especially for monkeys",
		"The worst way to be murdered",
		"A better name for testicles",
		"Invent a family-friendly replacement word that you could say instead of an actual curse word",
		"Where do babies come from?",
		"A fun thing to think about during mediocre sex",
		"Something you should never stick up your butt",
		"A good catchphrase to yell every time you finish pooping",
		"Make up the title of a movie that is based on the first time you had sex",
		"A great name for a nude beach in Alaska",
		"A good stage name for a chimpanzee stripper",
		"The best place to bury all those bodies",
		"If we can\u2019t afford to bury or cremate you, what should we do with your body?",
		"Come up with a name for a new, very manly cocktail",
		"Make up a name for a silent-film porno from the 1920s",
		"Something you should not whisper to your grandmother",
		"The worst thing that could jump out of a bachelor party cake",
		"What aliens do with you after the anal probe",
		"You should never give alcohol to __          __",
		"A great brand name for extra-extra-large condoms",
		"What the genitalia on a Tofurky is called",]
});
