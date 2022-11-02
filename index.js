// Import the necessary dependencies
const core = require('@actions/core')
const { exec } = require('child_process')
const github = require('@actions/github')
const ipInfo = require('ipinfo')
const azureRegions = require('./data/azure-regions.json')
const os = require('node:os')

async function run() {
	// Determine OS of runner
	const RUNNER_PLATFORM = os.platform()
	const RUNNER_OS = await _getRunnerOs(RUNNER_PLATFORM)
	core.info(`Runner OS: ${RUNNER_OS}`)

	// Get IP info of the runner machine
	const IP_INFO = await _getIPInfo()
	core.info(`Runner IP: ${IP_INFO.ip}`)
	core.info(`Runner IP location: ${IP_INFO.region}`)

	// Get Azure region corresponding to runner location
	const RUNNER_LOCATION = await _getRunnerLocation(IP_INFO.region)
	core.info(`Matching Azure region: ${RUNNER_LOCATION}`)
}

run()

async function _getRunnerOs(platform) {
	switch (platform) {
		case 'linux':
			return 'linux'
		case 'darwin':
			return 'macos'
		case 'win32':
			return 'windows'
		default:
			core.warning('Unable to determine the OS of the runner, the workflow will continue.')
			return
	}
}

async function _getIPInfo() {
	const IPInfo = ipInfo()

	return IPInfo
}

async function _getRunnerLocation(location) {
	let matchingRegions = []

	for (const region in azureRegions) {
		if (azureRegions[region].state == location) {
			matchingRegions.push(region)
		}
	}

	// TODO - how to deal with multiple regions in the same state?
	//   E.g. there are two azure datacenters in Virginia, but it's hard to get granular enough data to distinguish the two
	return matchingRegions[0]
}
