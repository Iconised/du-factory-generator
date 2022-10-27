import { Container } from "./container"
import {
    FactoryGraph,
    FactoryNode,
    MAX_CONTAINER_LINKS,
    MAX_INDUSTRY_LINKS,
    PerSecond,
} from "./graph"
import { CATALYSTS, isOre, Item, getRecipe, Category, matchesCategory } from "./items"
import { generateDumpRoutes } from "./router"
import { isTransferContainer, TransferContainer } from "./transfer-container"
import { isTransferUnit } from "./transfer-unit"
import { sanityCheck, mergeFactory, unmergeFactory } from "./utils"

export type SelectedCategories = Category[]

export type AddProductionNodeOptions = {
    filterCategories: SelectedCategories;
}

/**
 * Add a production node for a given item if it doesn't exist, then call this function
 * recursively for all item ingredients.
 * @param item Item to produce
 * @param factory the FactoryGraph
 */
function addProductionNode(item: Item, factory: FactoryGraph, options?: AddProductionNodeOptions): FactoryNode {

    if (!options) {
        options = { filterCategories: [] }
    }

    // Get node if it exists
    const node = factory.getNode(item)
    if (node !== undefined) {
        return node
    }

    // Create an ore node and terminate recursion
    if (isOre(item)) {
        const oreNode = factory.createOreNode(item)
        return oreNode
    }

    // Add this item to the tree
    const productionNode = factory.createProductionNode(item)

    // Add all ingredients
    const recipe = getRecipe(item, factory.talentLevels)
    for (const [ingredient, quantity] of recipe.ingredients.entries()) {
        // Catch empty recipes (e.g., gas)
        if (ingredient === undefined) {
            continue
        }

        // Add ingredients to tree
        const inputNode = addProductionNode(ingredient, factory, options)

        // Link ingredients to node
        inputNode.addConsumer(productionNode)
    }

    // Return new node
    return productionNode
}

/**
 * Add transfer units to move byproducts
 * @param factory the factory graph
 */
function handleByproducts(factory: FactoryGraph) {
    // Handle byproducts
    for (const container of factory.dumpContainers) {
        if (container.recipe === undefined) {
            // no byproducts
            continue
        }

        for (const [byproduct, quantity] of container.recipe.byproducts.entries()) {
            // maximum transfer rate supported by a single transfer unit
            const maxTransferRate = byproduct.transferBatchSize / byproduct.transferTime

            // Check if this container already has a transfer unit for the byproduct
            let found = false
            for (const consumer of container.consumers) {
                if (isTransferUnit(consumer) && consumer.item == byproduct) {
                    found = true
                    // ensure that the transfer rate is set
                    consumer.setTransferRate(container, container.ingress(byproduct))
                    // ensure that we do not exceed one transfer unit for this byproduct
                    // THIS IS A HACK
                    if (consumer.requiredTransferRate > maxTransferRate) {
                        for (const tuContainer of consumer.inputs) {
                            const share = container.ingress(byproduct) / maxTransferRate
                            consumer.setTransferRate(
                                tuContainer,
                                share * container.ingress(byproduct),
                            )
                        }
                        consumer.requiredTransferRate = maxTransferRate
                    }
                    break
                }
            }
            if (found) {
                continue
            }

            // Look for an existing transfer unit
            let foundTransferUnit = false
            const transferUnits = factory.getByproductTransferUnits(byproduct)
            for (const transferUnit of transferUnits) {
                if (transferUnit.canAddIncomingLink) {
                    foundTransferUnit = true
                    transferUnit.addInput(container)
                    transferUnit.increaseTransferRate(container, container.ingress(byproduct))
                    // ensure that we do not exceed one transfer unit for this byproduct
                    // THIS IS A HACK
                    if (transferUnit.requiredTransferRate > maxTransferRate) {
                        for (const tuContainer of transferUnit.inputs) {
                            const share = container.ingress(byproduct) / maxTransferRate
                            transferUnit.setTransferRate(
                                tuContainer,
                                share * container.ingress(byproduct),
                            )
                        }
                        transferUnit.requiredTransferRate = maxTransferRate
                    }
                    break
                }
            }
            if (foundTransferUnit) {
                continue
            }

            // Find a dump container storing byproduct that doesn't already have
            // a transfer unit dumping into it and can support an additional incoming link
            const dumpContainers = factory.getDumpContainers(byproduct)
            let outputContainer = undefined
            let minTransferUnits = MAX_CONTAINER_LINKS
            for (const checkContainer of dumpContainers) {
                const numTransferUnits = Array.from(checkContainer.producers).filter(
                    isTransferUnit,
                ).length
                minTransferUnits = Math.min(minTransferUnits, numTransferUnits)
                if (checkContainer.canAddIncomingLinks(1) && numTransferUnits === 0) {
                    outputContainer = checkContainer
                    break
                }
            }

            // Find a dump container storing byproduct that can support an additional incoming link
            // and has the minimum number of transfer units
            if (outputContainer === undefined) {
                for (const checkContainer of dumpContainers) {
                    const numTransferUnits = Array.from(checkContainer.producers).filter(
                        isTransferUnit,
                    ).length
                    if (
                        checkContainer.canAddIncomingLinks(1) &&
                        numTransferUnits === minTransferUnits
                    ) {
                        outputContainer = checkContainer
                        break
                    }
                }
            }

            // Create a new DumpContainer for this product if necessary
            if (outputContainer === undefined) {
                outputContainer = factory.createDumpContainer(byproduct)
            }

            // Add new transfer unit
            const transferUnit = factory.createTransferUnit(byproduct, outputContainer)
            transferUnit.increaseRequiredTransferRate(container.ingress(byproduct))
            transferUnit.addInput(container)
            transferUnit.increaseTransferRate(container, container.ingress(byproduct))
            // ensure that we do not exceed one transfer unit for this byproduct
            // THIS IS A HACK
            if (transferUnit.requiredTransferRate > maxTransferRate) {
                transferUnit.setTransferRate(container, maxTransferRate)
                transferUnit.requiredTransferRate = maxTransferRate
            }
        }
    }
}

/**
 * Add transfer units to balance catalysts
 * @param factory the factory graph
 */
function balanceCatalysts(factory: FactoryGraph) {
    // Chain catalyst dump containers together (0 <-> 1 <-> 2 ... etc.)
    for (const catalyst of CATALYSTS) {
        const containers = factory.getDumpContainers(catalyst)
        let lastContainer: Container | undefined = undefined
        for (const container of containers) {
            if (lastContainer === undefined) {
                lastContainer = container
                continue
            }

            // check if previous container has a link to this one
            let transferUnits = Array.from(lastContainer.consumers)
                .filter(isTransferUnit)
                .filter((node) => node.output === container)
            if (transferUnits.length === 0) {
                const transferUnit = factory.createTransferUnit(catalyst, container)
                const rate: PerSecond = 1.0 / 11.0 // HACK
                transferUnit.increaseRequiredTransferRate(rate)
                transferUnit.addInput(lastContainer)
                transferUnit.increaseTransferRate(lastContainer, rate)
            }

            // check if this container has link to previous one
            transferUnits = Array.from(container.consumers)
                .filter(isTransferUnit)
                .filter((node) => node.output === lastContainer)
            if (transferUnits.length === 0) {
                const transferUnit = factory.createTransferUnit(catalyst, lastContainer)
                const rate: PerSecond = 1.0 / 11.0 // HACK
                transferUnit.increaseRequiredTransferRate(rate)
                transferUnit.addInput(container)
                transferUnit.increaseTransferRate(container, rate)
            }
            lastContainer = container
        }
    }
}

/**
 * Add TransferContainers as necessary to satisfy industries that required too many links
 * @param factory the factory graph
 */
function handleTransferContainers(factory: FactoryGraph) {
    // Add transfer containers for industries with too many incoming links
    for (const industry of factory.industries) {
        const exceedingLinkCount = industry.incomingLinkCount - MAX_INDUSTRY_LINKS
        if (exceedingLinkCount <= 0) {
            continue
        }

        // Sort ingredients by quantity
        const ingredients = Array.from(
            new Map([...industry.recipe.ingredients.entries()].sort((a, b) => a[1] - b[1])).keys(),
        )

        // Try to use an existing transfer container
        const transferContainers = factory.getTransferContainers(new Set(ingredients))
        let transferContainer: TransferContainer | undefined = undefined
        for (const checkTransferContainer of transferContainers) {
            // We need to remove (exceedingLinkCount + 1) links from the industry and add
            // one link from a transfer container. Check if this transfer container holds
            // at least (exceedingLinkCount + 1) items.
            if (checkTransferContainer.items.length < exceedingLinkCount + 1) {
                continue
            }

            // Check that we can add an outgoing link
            if (!checkTransferContainer.canAddOutgoingLink) {
                continue
            }

            // We have to ensure that the ingredients are drawn from the relay containers
            // that this industry uses. Check that each transfer container transfer unit
            // draws from one of the industry inputs.
            let transferUnitsGood = true
            for (const transferUnit of checkTransferContainer.producers) {
                if (!Array.from(transferUnit.inputs).some((input) => industry.inputs.has(input))) {
                    transferUnitsGood = false
                }
            }
            if (!transferUnitsGood) {
                continue
            }

            // good
            transferContainer = checkTransferContainer
            break
        }

        // Create a new transfer container if necessary
        if (transferContainer === undefined) {
            const items = ingredients.slice(0, exceedingLinkCount + 1)
            transferContainer = factory.createTransferContainer(items)

            // Add transfer units
            for (const item of items) {
                const transferUnit = factory.createTransferUnit(item, transferContainer)
            }
        }

        // Remove existing container->industry links, and replace with
        // container->transfer unit links
        for (const transferUnit of transferContainer.producers) {
            let check = false
            for (const container of industry.inputs) {
                if (isTransferContainer(container)) {
                    continue
                }
                if (container.item === transferUnit.item) {
                    const transferRate = industry.inflowRateFrom(container, container.item)
                    industry.removeInput(container)
                    transferUnit.addInput(container)
                    transferUnit.increaseRequiredTransferRate(transferRate)
                    transferUnit.increaseTransferRate(container, transferRate)
                    check = true
                    break
                }
            }
            if (!check) {
                console.log(industry)
                console.log(transferUnit)
                throw new Error("Unable to transfer item")
            }
        }

        // Link transfer container to industry
        industry.addInput(transferContainer)
    }
}

/**
 * Add gas producers to satisfy gas nodes
 * @param factory the factory graph
 */
function handleGas(factory: FactoryGraph) {
    // Loop over gas nodes
    for (const node of factory.gasNodes) {
        // update relay node transfer unit transfer rate
        // to match fractional production normalized by
        // relay throughput, or actual consumption rate,
        // whichever is smaller
        const totalEgress = node
            .getRelayRoutes()
            .map((route) => route.container.egress(node.item))
            .reduce((total, current) => total + current, 0)

        for (const relayRoute of node.getRelayRoutes()) {
            for (const dumpRoute of node.dumpRoutes) {
                const transferRate = Math.min(
                    relayRoute.container.egress(node.item),
                    (dumpRoute.container.ingress(node.item) *
                        relayRoute.container.egress(node.item)) /
                        totalEgress,
                )

                relayRoute.transferUnit.setTransferRate(dumpRoute.container, transferRate)
            }
        }

        // update dump routes allowing gas nodes to have multiple industries
        generateDumpRoutes(node, false)
    }
}

/**
 * Build a new factory graph or add to an existing graph
 * @param requirements The items and rates of new items to produce
 * @param talentLevels Talent levels
 * @param factory The existing factory graph, if any
 */
export function buildFactory(
    requirements: Map<Item, { rate: PerSecond; maintain: number }>,
    talentLevels: { [key: string]: number },
    factory?: FactoryGraph,
    options?: AddProductionNodeOptions
) {
    // Start a new graph if necessary
    if (factory === undefined) {
        factory = new FactoryGraph(talentLevels)
    } else {
        // Umerge dump and relay containers
        unmergeFactory(factory)
    }

    // Add required production nodes
    for (const [item, { rate, maintain }] of requirements.entries()) {
        // add or update production node for this item
        const node = addProductionNode(item, factory, options)
        node.outputRate += rate
        node.maintainedOutput += maintain
    }

    // Route and build nodes starting from the raw ores
    for (const node of factory.oreNodes) {
        node.getRelayRoutes()
    }
    // Route and build nodes starting from the gas dump routes
    for (const node of factory.gasNodes) {
        node.getDumpRoutes()
    }

    // Transfer byproducts
    handleByproducts(factory)

    // Balance catalysts
    balanceCatalysts(factory)

    // Handle transfer contianers
    handleTransferContainers(factory)

    // Add gas producers if necessary
    handleGas(factory)

    // Merge dump and relay containers
    mergeFactory(factory)

    // sanity check
    sanityCheck(factory)

    return factory
}
