const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    try {
        const payload = JSON.parse(event.body);
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        
        // 1. 先查询数据库中是否已经存在该姓名的选手
        const { data: existingData } = await supabase
            .from('player_stats')
            .select('player_name')
            .eq('player_name', payload.player_name)
            .maybeSingle();
            
        // 2. 更新或插入当前报名玩家的数据
        if (existingData) {
            const { error } = await supabase
                .from('player_stats')
                .update(payload)
                .eq('player_name', payload.player_name);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('player_stats')
                .insert([payload]);
            if (error) throw error;
        }
        
        // 3. 拉取全服所有玩家的数据，重新计算所有人的排名和分组
        const { data: allPlayers, error: fetchError } = await supabase
            .from('player_stats')
            .select('player_name, hw_score, pre_group');
            
        if (fetchError) throw fetchError;

        // 按照华为分降序排列
        allPlayers.sort((a, b) => b.hw_score - a.hw_score);

        const totalPlayers = allPlayers.length;
        const legendCount = Math.ceil(totalPlayers * 0.30);
        const middleCount = Math.ceil(totalPlayers * 0.60);

        // 收集需要更新分组的玩家请求
        const updatePromises = [];

        allPlayers.forEach((player, index) => {
            const rank = index + 1;
            let newGroup = '挑战组';
            
            // 计算这个玩家现在应该属于哪个组
            if (rank <= legendCount) {
                newGroup = '传奇组';
            } else if (rank <= middleCount) {
                newGroup = '中间组';
            }

            // 如果该玩家现在应该在的组和数据库里存的不一致，说明由于新人加入导致了名次挤压，需要刷新他
            if (player.pre_group !== newGroup) {
                updatePromises.push(
                    supabase
                        .from('player_stats')
                        .update({ pre_group: newGroup })
                        .eq('player_name', player.player_name)
                );
            }
        });

        // 4. 并发执行所有需要刷新的更新操作
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }
        
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
