const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 核心配置区：方便后期统一调整比例和参数
// ==========================================
const CONFIG = {
    // 1. 组别比例分布
    groupProportions: {
        legend: 0.30, // 传奇组 (Top 30%)
        middle: 0.60  // 中间组 (30% - 60%)
    },
    
    // 2. 各位置数据分权重 (单项满分上限，总和 ±600分)
    roleWeights: {
        '一突': { acs: 180, adr: 180, kda: 120, kast: 120 },
        '二突': { acs: 150, adr: 150, kda: 150, kast: 150 },
        '先锋': { acs: 120, adr: 120, kda: 150, kast: 210 },
        '烟位': { acs: 90,  adr: 90,  kda: 180, kast: 240 },
        '哨位': { acs: 120, adr: 90,  kda: 210, kast: 180 }
    },
    
    // 3. 各项数据基准线与标准差 (S型衰减算法核心参数)
    baselines: {
        acs:  { base: 200, sd: 50 },
        adr:  { base: 130, sd: 30 },
        kda:  { base: 1.4, sd: 0.5 },
        kast: { base: 70,  sd: 10 }
    }
};

// ==========================================
// 辅助计算工具函数
// ==========================================

// 生成段位列表
const rankTiers = [];
const rankNames = ['黑铁', '青铜', '白银', '黄金', '白金', '钻石', '超凡', '神话'];
rankNames.forEach(name => { for (let i = 1; i <= 3; i++) rankTiers.push(`${name}${i}`); });
rankTiers.push('辐能');

// 获取段位基础分
function getRankScore(tier) {
    const idx = rankTiers.indexOf(tier);
    if (tier === '辐能') return 2500;
    if (idx === -1) return 0;
    return idx * 100;
}

// 反正切单项得分计算
function getArctanScore(val, base, sd, maxWeight) {
    return maxWeight * (2 / Math.PI) * Math.atan((val - base) / sd);
}

// 计算单个玩家的华为分
function calculateHwScore(player) {
    const rankScore = getRankScore(player.rank_tier);
    const role = player.player_role || '一突';
    const weight = CONFIG.roleWeights[role] || CONFIG.roleWeights['一突'];

    // 确保从数据库取出的字段转为浮点数计算
    const acs = parseFloat(player.acs || 0);
    const adr = parseFloat(player.adr || 0);
    const kda = parseFloat(player.kda || 0);
    const kast = parseFloat(player.kast || 0);

    const dataScore = 
        getArctanScore(acs, CONFIG.baselines.acs.base, CONFIG.baselines.acs.sd, weight.acs) +
        getArctanScore(adr, CONFIG.baselines.adr.base, CONFIG.baselines.adr.sd, weight.adr) +
        getArctanScore(kda, CONFIG.baselines.kda.base, CONFIG.baselines.kda.sd, weight.kda) +
        getArctanScore(kast, CONFIG.baselines.kast.base, CONFIG.baselines.kast.sd, weight.kast);

    return Math.round(rankScore + dataScore);
}

// ==========================================
// 主处理逻辑
// ==========================================
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    try {
        const payload = JSON.parse(event.body);
        
        // 使用 SERVICE_ROLE_KEY 绕过 RLS 策略，确保更新权限
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
        const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);
        
        // 1. 查询数据库中是否已经存在该姓名的选手
        const { data: existingData } = await supabase
            .from('player_stats')
            .select('player_name')
            .eq('player_name', payload.player_name)
            .maybeSingle();
            
        // 2. 更新或插入当前报名玩家的最新原始数据
        if (existingData) {
            const { data: updatedData, error } = await supabase
                .from('player_stats')
                .update(payload)
                .eq('player_name', payload.player_name)
                .select();
                
            if (error) throw error;
            if (!updatedData || updatedData.length === 0) {
                throw new Error('更新失败：请确保 Netlify 环境变量中已正确配置 SUPABASE_SERVICE_ROLE_KEY');
            }
        } else {
            const { error } = await supabase
                .from('player_stats')
                .insert([payload]);
            if (error) throw error;
        }
        
        // 3. 拉取全服所有玩家的原始战绩数据，准备执行全局刷新
        const { data: allPlayers, error: fetchError } = await supabase
            .from('player_stats')
            .select('*');
            
        if (fetchError) throw fetchError;

        // 4. 利用最新 CONFIG 重新计算所有人的华为分
        allPlayers.forEach(p => {
            p.new_hw_score = calculateHwScore(p);
        });

        // 5. 按照新计算的华为分降序排列，计算全服组别分布
        allPlayers.sort((a, b) => b.new_hw_score - a.new_hw_score);

        const totalPlayers = allPlayers.length;
        const legendCount = Math.ceil(totalPlayers * CONFIG.groupProportions.legend);
        const middleCount = Math.ceil(totalPlayers * CONFIG.groupProportions.middle);

        const updatePromises = [];

        // 6. 找出因为公式变动或名次挤压导致“分数”或“分组”发生变化的玩家，加入更新队列
        allPlayers.forEach((player, index) => {
            const rank = index + 1;
            let newGroup = '挑战组';
            
            if (rank <= legendCount) {
                newGroup = '传奇组';
            } else if (rank <= middleCount) {
                newGroup = '中间组';
            }

            // 对比数据库内旧记录，若有变化才发起请求，节省资源
            if (player.hw_score !== player.new_hw_score || player.pre_group !== newGroup) {
                updatePromises.push(
                    supabase
                        .from('player_stats')
                        .update({ 
                            hw_score: player.new_hw_score, 
                            pre_group: newGroup 
                        })
                        .eq('player_name', player.player_name)
                );
            }
        });

        // 7. 并发执行所有需要刷新的更新操作
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }
        
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};